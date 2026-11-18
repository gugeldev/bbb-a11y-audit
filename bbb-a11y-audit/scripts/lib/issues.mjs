/**
 * Collects what is wrong with a run's input while it is being processed, so the agent gets every
 * problem in one pass instead of fixing them one at a time.
 *
 * problems  block the report: the input must be fixed and the build run again
 * warnings  are printed but do not block (for example, a screenshot marker that found nothing)
 */
export class Issues {
  problems = [];

  warnings = [];

  problem(message) {
    this.problems.push(message);
  }

  warn(message) {
    this.warnings.push(message);
  }
}

/** Prints `message` prefixed with the script name and exits with status 1. */
export function fail(message) {
  console.error(`build-report: ${message}`);
  process.exit(1);
}
