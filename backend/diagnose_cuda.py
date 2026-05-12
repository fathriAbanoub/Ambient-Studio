#!/usr/bin/env python3
"""Diagnose why CUDA visualizer is not being used."""

print("=" * 60)
print("CUDA VISUALIZER DIAGNOSTIC")
print("=" * 60)

# Test 1: Check if opencv is installed
print("\n1. Checking OpenCV installation...")
try:
    import cv2
    print(f"   ✓ OpenCV installed: {cv2.__version__}")
except ImportError as e:
    print(f"   ✗ OpenCV NOT installed: {e}")
    print("\n   FIX: Run 'pip install opencv-contrib-python'")
    exit(1)

# Test 2: Check CUDA support
print("\n2. Checking CUDA support in OpenCV...")
try:
    cuda_count = cv2.cuda.getCudaEnabledDeviceCount()
    print(f"   CUDA device count: {cuda_count}")
    if cuda_count > 0:
        print(f"   ✓ CUDA enabled: {cuda_count} device(s)")
    else:
        print("   ✗ No CUDA devices detected")
        print("\n   REASON: OpenCV not built with CUDA support")
        print("   FIX: Build OpenCV from source with CUDA enabled")
        print("        See: backend/INSTALL_CUDA.md")
except Exception as e:
    print(f"   ✗ CUDA check failed: {e}")
    exit(1)

# Test 3: Check if cuda_visualizer module can be imported
print("\n3. Checking cuda_visualizer module...")
try:
    from services.cuda_visualizer import render_video_cuda
    print("   ✓ cuda_visualizer module imported successfully")
except ImportError as e:
    print(f"   ✗ Failed to import cuda_visualizer: {e}")
    exit(1)

# Test 4: Check config
print("\n4. Checking configuration...")
try:
    from config import settings
    print(f"   USE_CUDA_VISUALIZER: {settings.USE_CUDA_VISUALIZER}")
    if not settings.USE_CUDA_VISUALIZER:
        print("   ⚠️  CUDA visualizer is DISABLED in config")
        print("   FIX: Set USE_CUDA_VISUALIZER=true in config.py")
except Exception as e:
    print(f"   ✗ Config check failed: {e}")

# Test 5: Check what video_renderer sees
print("\n5. Checking video_renderer CUDA detection...")
try:
    from services.video_renderer import _cuda_available
    print(f"   _cuda_available: {_cuda_available}")
    if not _cuda_available:
        print("   ✗ video_renderer thinks CUDA is NOT available")
        print("   This is why the old FFmpeg filter is being used!")
    else:
        print("   ✓ video_renderer detected CUDA successfully")
except Exception as e:
    print(f"   ✗ Failed to check video_renderer: {e}")

print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)

if cuda_count > 0:
    print("\n✅ CUDA is available and should work!")
    print("\nIf renders are still slow, check backend logs for:")
    print("  - '🚀 Using CUDA-accelerated visualizer'")
    print("  - '✓ CUDA renderer ready'")
    print("\nIf you see 'showfreqs' instead, restart the backend.")
else:
    print("\n❌ CUDA is NOT available")
    print("\nYour OpenCV installation does not have CUDA support.")
    print("The system will use the slower FFmpeg visualizer.")
    print("\nTo fix:")
    print("  1. Install CUDA Toolkit")
    print("  2. Build OpenCV with CUDA (see INSTALL_CUDA.md)")
    print("  3. Or accept slower performance with FFmpeg fallback")

print("\n" + "=" * 60)
