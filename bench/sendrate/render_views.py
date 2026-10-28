"""Pre-render what a phone camera sees of each transfer code (no sensor noise).

stdin JSON: {"w":1280,"h":720,"seed":1,"variants":3,"out":"/path/views.bin","codes":[{"size":n,"bits":"01.."}]}
Writes variants*len(codes) grayscale frames (h*w bytes each) to `out`, variant-major.
The phone's base pose is fixed per run; each variant (used for successive passes)
re-draws the small hand jitter, so a code is seen slightly differently each pass.
The code fills ~65% of the
frame height, with defocus blur, brightness falloff and reduced contrast.
Sensor noise and rolling-shutter tearing are added per frame by the simulator.
"""
import json, sys
import cv2
import numpy as np

req = json.load(sys.stdin)
W, H = req["w"], req["h"]
rng = np.random.default_rng(req["seed"])
base_span = H * rng.uniform(0.6, 0.7)
base_ang = np.deg2rad(rng.uniform(-6, 6))
base_k = rng.uniform(-0.08, 0.08)
blur = rng.uniform(0.6, 1.1)
fall = np.linspace(rng.uniform(0.8, 0.95), rng.uniform(0.95, 1.05), W, dtype=np.float32)[None, :]
gain, offset = rng.uniform(0.75, 0.9), rng.uniform(15, 35)
def parse(codes):
    return [(c["size"], np.array([0 if b == "1" else 255 for b in c["bits"]], dtype=np.uint8).reshape(c["size"], c["size"])) for c in codes]
# Optional "codesByVariant": a different encoding of the same codes per variant (e.g. rotated masks).
by_variant = [parse(cs) for cs in req["codesByVariant"]] if "codesByVariant" in req else None
base_codes = parse(req["codes"]) if by_variant is None else None
with open(req["out"], "wb") as f:
  for v in range(req.get("variants", 1)):
    jr = np.random.default_rng(req["seed"] * 1000 + v)
    for n, mods in (by_variant[v] if by_variant is not None else base_codes):
        mods = cv2.copyMakeBorder(mods, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
        px = max(3, 1000 // (n + 8))
        screen = cv2.resize(mods, None, fx=px, fy=px, interpolation=cv2.INTER_NEAREST).astype(np.float32)
        screen[:, ::3] *= 0.92  # sub-pixel structure
        s = screen.shape[0]
        span = base_span * jr.uniform(0.985, 1.015)       # hand jitter per code
        ang = base_ang + np.deg2rad(jr.uniform(-0.7, 0.7))
        cx, cy = W / 2 + jr.uniform(-8, 8), H / 2 + jr.uniform(-6, 6)
        half = span / 2
        pts = np.array([[-half, -half], [half, -half], [half, half], [-half, half]])
        pts[:, 0] *= 1 + base_k * (pts[:, 1] / half)
        rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
        dst = (pts @ rot.T + [cx, cy]).astype(np.float32)
        M = cv2.getPerspectiveTransform(np.float32([[0, 0], [s, 0], [s, s], [0, s]]), dst)
        frame = cv2.warpPerspective(screen, M, (W, H), flags=cv2.INTER_AREA, borderValue=60)
        frame = cv2.GaussianBlur(frame, (0, 0), blur)
        frame = frame * fall * gain + offset
        f.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
