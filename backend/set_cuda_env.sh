#!/bin/bash
# Source this file before starting the backend to enable CUDA support
# Usage: source backend/set_cuda_env.sh

for cuda_path in /usr/local/cuda/lib64 /usr/local/cuda/extras/CUPTI/lib64; do
  case ":$LD_LIBRARY_PATH:" in
    *:"$cuda_path":*) ;;
    *) export LD_LIBRARY_PATH="$cuda_path:$LD_LIBRARY_PATH" ;;
  esac
done

echo "✓ CUDA library path set: $LD_LIBRARY_PATH"
