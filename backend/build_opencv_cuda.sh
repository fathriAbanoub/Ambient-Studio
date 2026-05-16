#!/bin/bash
# OpenCV with CUDA Build Script
# For GTX 1650 Ti (Compute Capability 7.5) with CUDA 12.0

set -e  # Exit on error

echo "=========================================="
echo "OpenCV CUDA Build Script"
echo "GPU: GTX 1650 Ti (Compute 7.5)"
echo "CUDA: 12.0"
echo "=========================================="

# Step 1: Install dependencies
echo ""
echo "Step 1: Installing build dependencies..."
sudo apt update
sudo apt install -y \
    build-essential cmake git pkg-config \
    libjpeg-dev libtiff5-dev libpng-dev \
    libavcodec-dev libavformat-dev libswscale-dev \
    libv4l-dev libxvidcore-dev libx264-dev \
    libgtk-3-dev libatlas-base-dev gfortran \
    python3-dev python3-numpy \
    libtbb2 libtbb-dev libdc1394-dev

echo "✓ Dependencies installed"

# Step 2: Clone OpenCV repositories
echo ""
echo "Step 2: Cloning OpenCV repositories..."
cd ~
if [ -d "opencv" ] || [ -d "opencv_contrib" ]; then
    echo "opencv directory exists, removing..."
    rm -rf opencv opencv_contrib
fi

git clone --depth 1 --branch 4.8.0 https://github.com/opencv/opencv.git
git clone --depth 1 --branch 4.8.0 https://github.com/opencv/opencv_contrib.git

echo "✓ Repositories cloned"

# Step 3: Configure build
echo ""
echo "Step 3: Configuring CMake..."
cd ~/opencv
mkdir -p build
cd build

cmake -D CMAKE_BUILD_TYPE=RELEASE \
      -D CMAKE_INSTALL_PREFIX=/usr/local \
      -D OPENCV_EXTRA_MODULES_PATH=~/opencv_contrib/modules \
      -D WITH_CUDA=ON \
      -D WITH_CUDNN=OFF \
      -D OPENCV_DNN_CUDA=ON \
      -D ENABLE_FAST_MATH=ON \
      -D CUDA_FAST_MATH=ON \
      -D WITH_CUBLAS=ON \
      -D CUDA_ARCH_BIN=7.5 \
      -D CUDA_ARCH_PTX="" \
      -D WITH_TBB=ON \
      -D WITH_V4L=ON \
      -D WITH_QT=OFF \
      -D WITH_OPENGL=ON \
      -D BUILD_opencv_python3=ON \
      -D PYTHON3_EXECUTABLE=$(which python3) \
      -D PYTHON3_INCLUDE_DIR=$(python3 -c "from sysconfig import get_path; print(get_path('include'))") \
      -D PYTHON3_PACKAGES_PATH=$(python3 -c "from sysconfig import get_paths; print(get_paths()['purelib'])") \
      -D BUILD_EXAMPLES=OFF \
      -D BUILD_TESTS=OFF \
      -D BUILD_PERF_TESTS=OFF \
      ..

echo "✓ CMake configuration complete"

# Step 4: Build (this takes 20-30 minutes)
echo ""
echo "Step 4: Building OpenCV (this will take 20-30 minutes)..."
echo "Using $(nproc) CPU cores"
make -j$(nproc)

echo "✓ Build complete"

# Step 5: Install
echo ""
echo "Step 5: Installing OpenCV..."
sudo make install
sudo ldconfig

echo "✓ Installation complete"

# Step 6: Verify
echo ""
echo "Step 6: Verifying CUDA support..."
python3 - <<'PY'
import sys
import cv2
count = cv2.cuda.getCudaEnabledDeviceCount()
print(f"OpenCV version: {cv2.__version__}")
print(f"CUDA devices: {count}")
if count < 1:
    sys.exit("CUDA backend not available in cv2 build/runtime")
PY

echo ""
echo "=========================================="
echo "✅ OpenCV with CUDA built successfully!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Uninstall pip opencv: pip uninstall opencv-contrib-python opencv-python"
echo "2. Restart backend: cd backend && python main.py"
echo "3. Render a video and enjoy 6× speedup!"
