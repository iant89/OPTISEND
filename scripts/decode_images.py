"""Decode QR codes in PNG files (paths on stdin as JSON list) -> JSON list of
{"cv": str|null, "wechat": str|null}. Test helper."""
import json, sys
import cv2
paths = json.load(sys.stdin)
det = cv2.QRCodeDetector()
wechat = cv2.wechat_qrcode_WeChatQRCode()
out = []
for p in paths:
    img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
    d1, _, _ = det.detectAndDecode(img)
    r2, _ = wechat.detectAndDecode(img)
    out.append({"cv": d1 or None, "wechat": r2[0] if r2 else None})
json.dump(out, sys.stdout)
