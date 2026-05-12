#!/bin/bash
# Source this file before starting the backend to enable CUDA support
# Usage: source backend/set_cuda_env.sh

export LD_LIBRARY_PATH=/usr/local/cuda/lib64:/usr/local/cuda-12/lib64:$LD_LIBRARY_PATH

echo "✓ CUDA library path set: $LD_LIBRARY_PATH"
