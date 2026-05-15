#!/bin/bash
# Source this file before starting the backend to enable CUDA support
# Usage: source backend/set_cuda_env.sh

CUDA_PATHS="/usr/local/cuda/lib64:/usr/local/cuda-12/lib64"

if [[ ":$LD_LIBRARY_PATH:" != *":$CUDA_PATHS:"* ]]; then
  export LD_LIBRARY_PATH=$CUDA_PATHS:$LD_LIBRARY_PATH
fi

echo "✓ CUDA library path set: $LD_LIBRARY_PATH"
