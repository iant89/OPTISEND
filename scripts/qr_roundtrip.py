"""Optical-path simulation used by tests/optical-roundtrip.test.ts.

Reads JSON {version, ecc, frames:[text,...]} on stdin. For each frame: encode a
real QR symbol (alphanumeric mode) with OpenCV, upscale it, apply mild blur and
noise to imitate a camera capture, then decode it — OpenCV's QRCodeDetector first, falling back to the
WeChat decoder (mirrors the spec's "native detector + fallback" strategy).
Writes JSON [decoded_text_or_null, ...] to stdout.
"""
import json, sys
import cv2
import numpy as np

req = json.load(sys.stdin)
p = cv2.QRCodeEncoder_Params()
p.version = req["version"]
p.correction_level = getattr(cv2, "QRCODE_ENCODER_CORRECT_LEVEL_" + req["ecc"])
p.mode = cv2.QRCODE_ENCODER_MODE_ALPHANUMERIC
enc = cv2.QRCodeEncoder_create(p)
det = cv2.QRCodeDetector()
wechat = cv2.wechat_qrcode_WeChatQRCode()
rng = np.random.default_rng(req.get("seed", 1))
out = []
for text in req["frames"]:
    img = enc.encode(text)
    img = cv2.copyMakeBorder(img, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)  # full quiet zone
    img = cv2.resize(img, None, fx=6, fy=6, interpolation=cv2.INTER_NEAREST)
    img = cv2.GaussianBlur(img, (3, 3), 0.8)
    noise = rng.normal(0, 8, img.shape)
    img = np.clip(img.astype(np.float64) + noise, 0, 255).astype(np.uint8)
    data, _, _ = det.detectAndDecode(img)
    if not data:
        res, _ = wechat.detectAndDecode(img)
        data = res[0] if res else None
    out.append(data if data else None)
json.dump(out, sys.stdout)
