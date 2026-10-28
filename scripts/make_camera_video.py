"""Turn sender screenshots into a fake-camera Y4M video for Chromium.

argv: out.y4m frames_per_code seed screenshot1.png [screenshot2.png ...]
Each screenshot (the whole sender monitor) is 'filmed' by a phone held close:
slight rotation + keystone, the screen filling most of the frame, defocus
blur, brightness falloff, reduced contrast and sensor noise. Every code is
held for `frames_per_code` frames at 10 fps; Chromium loops the file, which
also exercises multi-pass recovery of missed codes.
"""
import sys
import cv2
import numpy as np

out_path, per_code, seed, paths = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]
W, H = 960, 540
rng = np.random.default_rng(seed)
with open(out_path, "wb") as f:
    f.write(f"YUV4MPEG2 W{W} H{H} F10:1 Ip A1:1 C420jpeg\n".encode())
    for p in paths:
        shot = cv2.imread(p, cv2.IMREAD_COLOR).astype(np.float32)
        sh, sw = shot.shape[:2]
        for _ in range(per_code):
            # Hand-held pose, re-sampled every frame (small jitter like a real hand).
            scale = H * rng.uniform(0.82, 0.95) / sh            # the code fills most of the frame height
            # The code sits left of the screenshot centre (control panel on the right): aim at it.
            cx, cy = W / 2 + rng.uniform(-25, 25) + 180 * scale, H / 2 + rng.uniform(-15, 15)
            ang = np.deg2rad(rng.uniform(-4, 4))
            k = rng.uniform(-0.06, 0.06)
            hw, hh = sw * scale / 2, sh * scale / 2
            pts = np.array([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]])
            pts[:, 0] *= 1 + k * (pts[:, 1] / hh)
            rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
            dst = (pts @ rot.T + [cx, cy]).astype(np.float32)
            M = cv2.getPerspectiveTransform(np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]), dst)
            frame = cv2.warpPerspective(shot, M, (W, H), flags=cv2.INTER_AREA, borderValue=(40, 40, 40))
            frame = cv2.GaussianBlur(frame, (0, 0), rng.uniform(0.5, 1.0))
            fall = np.linspace(rng.uniform(0.82, 0.95), rng.uniform(0.95, 1.05), W, dtype=np.float32)[None, :, None]
            frame = frame * fall * rng.uniform(0.8, 0.92) + rng.uniform(12, 30)
            frame = frame + rng.normal(0, rng.uniform(2, 5), frame.shape)
            frame = np.clip(frame, 0, 255).astype(np.uint8)
            f.write(b"FRAME\n")
            f.write(cv2.cvtColor(frame, cv2.COLOR_BGR2YUV_I420).tobytes())
