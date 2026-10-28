"""Cross-check src/qr/capacity.ts against OpenCV's independent QR encoder.

For every version 1-40 and ECC level L/M/Q/H, in byte and alphanumeric mode:
  * a payload of exactly the computed capacity must encode at that version, and
  * capacity + 1 must NOT fit that version (OpenCV escalates or fails).
Run: python3 scripts/verify_qr_capacity.py   (needs node + tsx for the table dump)
"""
import json, subprocess, sys
import cv2

table = json.loads(subprocess.check_output(["npx", "tsx", "scripts/dump_capacity.ts"], text=True))
LEVELS = {"L": cv2.QRCODE_ENCODER_CORRECT_LEVEL_L, "M": cv2.QRCODE_ENCODER_CORRECT_LEVEL_M,
          "Q": cv2.QRCODE_ENCODER_CORRECT_LEVEL_Q, "H": cv2.QRCODE_ENCODER_CORRECT_LEVEL_H}
MODES = {"byte": (cv2.QRCODE_ENCODER_MODE_BYTE, "a"), "alnum": (cv2.QRCODE_ENCODER_MODE_ALPHANUMERIC, "A")}

def fits(version, level, mode, n):
    p = cv2.QRCodeEncoder_Params()
    p.version = version
    p.correction_level = LEVELS[level]
    p.mode = MODES[mode][0]
    try:
        img = cv2.QRCodeEncoder_create(p).encode(MODES[mode][1] * n)
    except cv2.error:
        return False
    if img is None or img.size == 0:
        return False
    return img.shape[0] == 17 + 4 * version + 4  # OpenCV adds a 2-module border per side

errors = 0
for mode in MODES:
    for level in LEVELS:
        caps = table[f"{mode}_{level}"]
        for v in range(1, 41):
            cap = caps[v - 1]
            if not fits(v, level, mode, cap):
                print(f"FAIL {mode} v{v}-{level}: capacity {cap} does not fit"); errors += 1
            if fits(v, level, mode, cap + 1):
                print(f"FAIL {mode} v{v}-{level}: capacity+1 ({cap + 1}) still fits"); errors += 1
print(f"checked {2 * 4 * 40} configurations, {errors} errors")
sys.exit(1 if errors else 0)
