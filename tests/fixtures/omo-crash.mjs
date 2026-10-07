if (process.argv.includes("--version")) {
  process.stdout.write("omo 0.0.0-crash (engine: none)\n");
} else {
  process.stderr.write("omo-crash: fatal startup error\n");
  process.stdout.write("this is not json\n");
  process.exitCode = 3;
}
