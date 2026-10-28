"""QR reference tool for tests/qr-encoder.test.ts.

stdin: {"op": "encode", "cases": [{"version", "ecc", "mode": "byte"|"alphanumeric", "text"}]}
   -> [{"size": n, "bits": "0101...", "valid": bool}]  OpenCV's module matrix (1 = dark);
      valid = the reference itself decodes back to the input (OpenCV's encoder
      has occasional bugs, so only self-consistent references are trusted)
stdin: {"op": "decode", "scale": 4, "matrices": [{"size": n, "bits": "..."}]}
   -> [{"cv": str|null, "wechat": str|null}]  decode results of our rendered matrices
"""
import json, sys
import cv2
import numpy as np

LEVEL = {"L": cv2.QRCODE_ENCODER_CORRECT_LEVEL_L, "M": cv2.QRCODE_ENCODER_CORRECT_LEVEL_M,
         "Q": cv2.QRCODE_ENCODER_CORRECT_LEVEL_Q, "H": cv2.QRCODE_ENCODER_CORRECT_LEVEL_H}
MODE = {"byte": cv2.QRCODE_ENCODER_MODE_BYTE, "alphanumeric": cv2.QRCODE_ENCODER_MODE_ALPHANUMERIC}
req = json.load(sys.stdin)
out = []
det = cv2.QRCodeDetector()
wechat = cv2.wechat_qrcode_WeChatQRCode()

def decode(img, s):
    a = cv2.copyMakeBorder(img, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    a = cv2.resize(a, None, fx=s, fy=s, interpolation=cv2.INTER_NEAREST)
    d1, _, _ = det.detectAndDecode(a)
    r2, _ = wechat.detectAndDecode(a)
    return d1 or None, (r2[0] if r2 else None)

if req["op"] == "encode":
    for c in req["cases"]:
        p = cv2.QRCodeEncoder_Params()
        p.version, p.correction_level, p.mode = c["version"], LEVEL[c["ecc"]], MODE[c["mode"]]
        img = cv2.QRCodeEncoder_create(p).encode(c["text"])
        m = img[2:-2, 2:-2]  # strip OpenCV's 2-module border (1 px per module)
        valid = c["text"] in decode(m, 4)
        out.append({"size": int(m.shape[0]), "bits": "".join("1" if v < 128 else "0" for v in m.flatten()), "valid": valid})
else:
    for mt in req["matrices"]:
        n = mt["size"]
        a = np.array([0 if b == "1" else 255 for b in mt["bits"]], dtype=np.uint8).reshape(n, n)
        d1, d2 = decode(a, req.get("scale", 4))
        out.append({"cv": d1, "wechat": d2})
json.dump(out, sys.stdout)
