#!/usr/bin/env python3
"""
Verify CUDA environment for the backend process.
Run this to see what the backend will see when it starts.
"""

import sys
import os

print("=" * 70)
print("CUDA ENVIRONMENT VERIFICATION")
print("=" * 70)

print(f"\nPython executable: {sys.executable}")
print(f"Python version: {sys.version}")

print("\n1. Environment variables:")
print(f"   LD_LIBRARY_PATH: {os.environ.get('LD_LIBRARY_PATH', 'NOT SET')}")
print(f"   CUDA_HOME: {os.environ.get('CUDA_HOME', 'NOT SET')}")

print("\n2. OpenCV import:")
try:
    import cv2
    print(f"   ✓ OpenCV version: {cv2.__version__}")
    print(f"   ✓ OpenCV location: {cv2.__file__}")
except ImportError as e:
    print(f"   ✗ Failed to import cv2: {e}")
    sys.exit(1)

print("\n3. CUDA support:")
try:
    device_count = cv2.cuda.getCudaEnabledDeviceCount()
    print(f"   CUDA device count: {device_count}")
    if device_count > 0:
        print(f"   ✓ CUDA is available!")
        print(f"   Current device: {cv2.cuda.getDevice()}")
    else:
        print(f"   ✗ No CUDA devices detected")
        print("\n   Possible reasons:")
        print("   - OpenCV not built with CUDA support")
        print("   - CUDA runtime libraries not in LD_LIBRARY_PATH")
        print("   - GPU drivers not loaded")
except Exception as e:
    print(f"   ✗ CUDA check failed: {e}")
    import traceback
    traceback.print_exc()

print("\n4. CUDA visualizer import:")
try:
    from services.cuda_visualizer import render_video_cuda
    print(f"   ✓ cuda_visualizer module imported successfully")
except ImportError as e:
    print(f"   ✗ Failed to import cuda_visualizer: {e}")

print("\n5. CPU visualizer import:")
try:
    from services.cpu_visualizer import render_video_cpu
    print(f"   ✓ cpu_visualizer module imported successfully")
except ImportError as e:
    print(f"   ✗ Failed to import cpu_visualizer: {e}")

print("\n" + "=" * 70)
print("SUMMARY")
print("=" * 70)

if device_count > 0:
    print("\n✅ Environment is correctly configured for CUDA rendering!")
    print("\nThe backend should use the CUDA visualizer (~50s for 5-min video)")
else:
    print("\n⚠️  CUDA not detected - will fall back to CPU visualizer")
    print("\nTo fix:")
    print("  1. Ensure CUDA libraries are in LD_LIBRARY_PATH:")
    print("     export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH")
    print("  2. Restart the backend")
    print("  3. Run this script again to verify")

print("\n" + "=" * 70)
