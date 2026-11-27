const [verb, , flag, dir] = process.argv.slice(2);
if (verb === "__rex-resume" && flag === "--data-dir" && dir) process.env.HIVE_DATA_DIR = dir;
