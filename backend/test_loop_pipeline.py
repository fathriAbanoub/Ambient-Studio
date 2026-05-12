import sys
from pathlib import Path
import logging

# Add current directory to path so we can import services
sys.path.append(str(Path(__file__).parent))

from services.loop_analyzer import analyze_loop
from services.loop_processor import make_loop, extend_loop_seamless, get_audio_duration

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("test_loop")

def test_loop_pipeline(input_file: str, target_duration: float = 60.0):
    input_path = Path(input_file)
    if not input_path.exists():
        logger.error(f"Input file not found: {input_file}")
        return

    output_dir = Path("test_output")
    output_dir.mkdir(exist_ok=True)

    try:
        # 1. Analyze
        logger.info(f"Step 1: Analyzing {input_file}...")
        analysis = analyze_loop(input_path)
        logger.info(f"Analysis result: {analysis}")

        loop_start = analysis["loop_start_ms"] / 1000.0
        loop_end = analysis["loop_end_ms"] / 1000.0
        crossfade = analysis["crossfade_ms"] / 1000.0

        # 2. Make canonical loop unit
        loop_unit_path = output_dir / "canonical_loop.wav"
        logger.info(f"Step 2: Creating canonical loop unit at {loop_unit_path}...")
        make_loop(
            input_path,
            loop_unit_path,
            crossfade_seconds=crossfade,
            loop_start_seconds=loop_start,
            loop_end_seconds=loop_end
        )
        
        unit_duration = get_audio_duration(loop_unit_path)
        expected_duration = (loop_end - loop_start) - crossfade
        logger.info(f"Loop unit created. Duration: {unit_duration:.3f}s (Expected: ~{expected_duration:.3f}s)")

        # 3. Extend loop
        extended_path = output_dir / f"extended_loop_{int(target_duration)}s.wav"
        logger.info(f"Step 3: Extending loop to {target_duration}s at {extended_path}...")
        extend_loop_seamless(
            loop_unit_path,
            extended_path,
            target_duration
        )

        final_duration = get_audio_duration(extended_path)
        logger.info(f"Step 4: Verification complete. Final duration: {final_duration:.3f}s")
        
        logger.info("✅ Loop pipeline test PASSED")

    except Exception as e:
        logger.exception(f"❌ Loop pipeline test FAILED: {e}")

if __name__ == "__main__":
    # Use a sample file if available, otherwise just print usage
    # For testing, we expect an audio file to be passed or present in assets
    sample_file = "backend/assets/background.jpg" # Not an audio file, obviously
    # Let's see what's in output/ if anything
    output_files = list(Path("output").glob("*.wav"))
    if output_files:
        test_loop_pipeline(str(output_files[0]))
    else:
        logger.error("No sample WAV file found in 'output/' to test with. Run a render first or provide a file path.")
