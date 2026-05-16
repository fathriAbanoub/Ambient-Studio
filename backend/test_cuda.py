#!/usr/bin/env python3
"""
Quick test script to verify CUDA visualizer setup.
"""

import sys

print("Testing CUDA visualizer dependencies...\n")

# Test 1: OpenCV
try:
    import cv2
    print(f"✓ OpenCV installed: {cv2.__version__}")
except ImportError as e:
    print(f"✗ OpenCV not installed: {e}")
    sys.exit(1)

# Test 2: CUDA support
try:
    cuda_count = cv2.cuda.getCudaEnabledDeviceCount()
    if cuda_count > 0:
        print(f"✓ CUDA enabled: {cuda_count} device(s) detected")
        for i in range(cuda_count):
            print(f"  Device {i}: {cv2.cuda.getDevice()}")
    else:
        print("✗ No CUDA-enabled GPU detected")
        print("  Note: OpenCV may not be built with CUDA support")
        sys.exit(1)
except Exception as e:
    print(f"✗ CUDA check failed: {e}")
    sys.exit(1)

# Test 3: Librosa
try:
    import librosa
    print(f"✓ Librosa installed: {librosa.__version__}")
except ImportError as e:
    print(f"✗ Librosa not installed: {e}")
    sys.exit(1)

# Test 4: NumPy
try:
    import numpy as np
    print(f"✓ NumPy installed: {np.__version__}")
except ImportError as e:
    print(f"✗ NumPy not installed: {e}")
    sys.exit(1)

print("\n✅ All dependencies OK! CUDA visualizer ready to use.")
print("\nTo enable: Set USE_CUDA_VISUALIZER=true in config (default)")
print("To disable: Set USE_CUDA_VISUALIZER=false")
