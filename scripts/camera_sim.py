"""Simulate a phone camera filming a monitor that shows a QR code.

stdin JSON: {"seed": int, "cases": [{"size": n, "bits": "0101...", "crop": {"fraction": f, "side": px}}]}
For each case: render the code on a 'screen' (with a faint RGB sub-pixel grid),
photograph it with random tilt/rotation, scale, defocus blur, brightness
gradient, gamma and sensor noise into a camera frame (default 1920x1080, the resolution the app requests), then apply the same
centred crop + downscale the browser scanner uses.
stdout: newline-separated base64 grayscale images (side x side), one per case.

Optional: "crop": null returns the whole camera frame ("<b64>:<W>x<H>") so the
receiver's own locate-and-crop can be measured; a case with "blank": true films
a screen of random UI-like rectangles and text strokes instead of a code.
Knobs "span" [lo, hi] (code height / frame height) and "offset" [dx, dy]
(max centre offset in pixels) vary distance and aim.

Colour (experimental RGB-layer QR): a case with "layers": [bits_r, bits_g, bits_b]
(three same-size codes) is shown as a colour composite and filmed through a
colour camera model: screen/sensor crosstalk ("crosstalk", share of each
channel leaking into the others), white-balance error ("wb", ± gain), Bayer
RGGB sampling with demosaicing, per-photosite noise, and 4:2:0 chroma
subsampling like camera video. Output is RGB ("<b64>:<W>x<H>x3"; crop must be null).
"""
import base64, json, sys
import cv2
import numpy as np

req = json.load(sys.stdin)
rng = np.random.default_rng(req.get("seed", 1))
K = {"w": 1920, "h": 1080, "rot": 8, "keystone": 0.12, "blur": 1.4, "noise": 8, "moire": 0.9, "contrast": True, "span": [0.45, 0.65], "offset": [60, 40], "crosstalk": 0.12, "wb": 0.1}
K.update(req.get("knobs", {}))
W, H = K["w"], K["h"]
out = []
for c in req["cases"]:
    if c.get("blank"):
        # A busy non-QR screen: random panels, buttons and text-like strokes.
        screen = np.full((1000, 1000), 235, np.uint8)
        for _ in range(int(rng.integers(8, 20))):
            x, y = rng.integers(0, 900, 2)
            w, h = rng.integers(20, 300, 2)
            cv2.rectangle(screen, (int(x), int(y)), (int(x + w), int(y + h)), int(rng.integers(20, 220)), int(rng.choice([-1, 2, 4])))
        for _ in range(int(rng.integers(5, 15))):
            x, y = rng.integers(0, 900, 2)
            cv2.putText(screen, "OptiSend 0123 Files", (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, float(rng.uniform(0.5, 2)), 20, int(rng.integers(1, 4)))
        screen = screen.astype(np.float32)
    else:
        n = c["size"]
        layers = c.get("layers") or [c["bits"]]
        chans = []
        for bits in layers:
            mods = np.array([0 if b == "1" else 255 for b in bits], dtype=np.uint8).reshape(n, n)
            mods = cv2.copyMakeBorder(mods, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
            px = max(3, 1000 // (n + 8))                      # integer device pixels per module, like the sender
            chans.append(cv2.resize(mods, None, fx=px, fy=px, interpolation=cv2.INTER_NEAREST).astype(np.float32))
        screen = chans[0] if len(chans) == 1 else np.dstack(chans)  # RGB
    # Faint sub-pixel structure: every 3rd column slightly darker (source of moire after resampling).
    screen[:, ::3] *= K["moire"]
    s = screen.shape[0]
    # Camera pose: code spans 45-65% of the frame height, tilted up to ~12 degrees.
    span = H * rng.uniform(*K["span"])
    cx, cy = W / 2 + rng.uniform(-K["offset"][0], K["offset"][0]), H / 2 + rng.uniform(-K["offset"][1], K["offset"][1])
    ang = np.deg2rad(rng.uniform(-K["rot"], K["rot"]))
    k = rng.uniform(-K["keystone"], K["keystone"])                     # keystone (perspective) strength
    half = span / 2
    base = np.array([[-half, -half], [half, -half], [half, half], [-half, half]])
    base[:, 0] *= 1 + k * (base[:, 1] / half)        # trapezoid
    rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
    dst = (base @ rot.T + [cx, cy]).astype(np.float32)
    src = np.float32([[0, 0], [s, 0], [s, s], [0, s]])
    M = cv2.getPerspectiveTransform(src, dst)
    colour = screen.ndim == 3
    frame = cv2.warpPerspective(screen, M, (W, H), flags=cv2.INTER_AREA, borderValue=(200, 200, 200) if colour else 200)
    # Optics + exposure + sensor.
    frame = cv2.GaussianBlur(frame, (0, 0), rng.uniform(min(0.6, K["blur"]), K["blur"])) if K["blur"] > 0 else frame
    if K["contrast"]:
        gx = np.linspace(rng.uniform(0.75, 1.0), rng.uniform(0.85, 1.1), W, dtype=np.float32)
        frame = frame * (gx[None, :, None] if colour else gx[None, :])
        frame = 255 * (np.clip(frame, 0, 255) / 255) ** rng.uniform(0.8, 1.25)
        frame = frame * rng.uniform(0.7, 0.95) + rng.uniform(10, 40)   # screens never reach pure black/white on camera
    if colour:
        # Each camera channel sees mostly its own screen primary plus some of the others; rows sum to 1 (white stays white).
        a = K["crosstalk"]
        mix = np.array([[1 - a, a * 0.75, a * 0.25], [a * 0.5, 1 - a, a * 0.5], [a * 0.25, a * 0.75, 1 - a]], np.float32)
        frame = frame @ mix.T
        frame = frame * rng.uniform(1 - K["wb"], 1 + K["wb"], 3).astype(np.float32)[None, None, :]
        # Bayer RGGB: each photosite records one channel, with its own noise; then demosaic.
        mosaic = np.empty((H, W), np.float32)
        mosaic[0::2, 0::2] = frame[0::2, 0::2, 0]
        mosaic[0::2, 1::2] = frame[0::2, 1::2, 1]
        mosaic[1::2, 0::2] = frame[1::2, 0::2, 1]
        mosaic[1::2, 1::2] = frame[1::2, 1::2, 2]
        if K["noise"] > 0:
            mosaic = mosaic + rng.normal(0, rng.uniform(min(3, K["noise"]), K["noise"]), mosaic.shape)
        frame = cv2.cvtColor(np.clip(mosaic, 0, 255).astype(np.uint8), cv2.COLOR_BayerBG2RGB)
        # Video is 4:2:0: chroma at half resolution in each direction.
        ycc = cv2.cvtColor(frame, cv2.COLOR_RGB2YCrCb)
        for ch in (1, 2):
            ycc[:, :, ch] = cv2.resize(cv2.resize(ycc[:, :, ch], (W // 2, H // 2), interpolation=cv2.INTER_AREA), (W, H), interpolation=cv2.INTER_LINEAR)
        frame = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB)
        out.append(base64.b64encode(np.ascontiguousarray(frame).tobytes()).decode() + ":" + f"{W}x{H}x3")
        continue
    if K["noise"] > 0:
        frame = frame + rng.normal(0, rng.uniform(min(3, K["noise"]), K["noise"]), frame.shape)
    frame = np.clip(frame, 0, 255).astype(np.uint8)
    if c.get("crop") is None:
        out.append(base64.b64encode(np.ascontiguousarray(frame).tobytes()).decode() + ":" + f"{W}x{H}")
        continue
    # Scanner crop + downscale.
    f, side = c["crop"]["fraction"], c["crop"]["side"]
    sq = int(min(W, H) * f)
    x0, y0 = (W - sq) // 2, (H - sq) // 2
    crop = frame[y0:y0 + sq, x0:x0 + sq]
    d = min(sq, side)
    crop = cv2.resize(crop, (d, d), interpolation=cv2.INTER_AREA)
    out.append(base64.b64encode(np.ascontiguousarray(crop).tobytes()).decode() + ":" + str(d))
sys.stdout.write("\n".join(out))
