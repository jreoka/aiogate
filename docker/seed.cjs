// One-time data seed for fresh/older volumes (e.g. Fly.io deploys where the
// volume starts empty and we can't copy files into the machine). The image
// may carry /app/data-seed, baked at build time from a real /app/data
// snapshot with a .seed-version file inside (e.g. `date +%s >
// seed-data/.seed-version`). If the volume is empty or carries an older seed
// version, replace the volume contents with the seed. Never touches a volume
// whose seed version is >= the image's, so live data is never clobbered by a
// stale image.
//
// Runs in the distroless base image, whose shell has almost no tools, so the
// whole copy is done here with node's fs.

const fs = require('fs');
const path = require('path');

const SEED_DIR = '/app/data-seed';
const VOL_DIR = '/app/data';

function readVersion(dir) {
  try {
    const v = fs.readFileSync(path.join(dir, '.seed-version'), 'utf8').trim();
    return /^\d+$/.test(v) ? parseInt(v, 10) : 0;
  } catch {
    return 0;
  }
}

if (!fs.existsSync(SEED_DIR)) process.exit(0);

const seedVer = readVersion(SEED_DIR);
const volVer = readVersion(VOL_DIR);

if (seedVer <= volVer) process.exit(0);

console.log(`[seed] seeding ${VOL_DIR} from image snapshot (seed v${seedVer}, volume v${volVer})`);
// Remove the volume's contents (not the mountpoint itself) then copy the seed in.
if (!fs.existsSync(VOL_DIR)) fs.mkdirSync(VOL_DIR, { recursive: true });
for (const entry of fs.readdirSync(VOL_DIR)) {
  fs.rmSync(path.join(VOL_DIR, entry), { recursive: true, force: true });
}
fs.cpSync(SEED_DIR, VOL_DIR, { recursive: true });
fs.rmSync(path.join(VOL_DIR, '.gitkeep'), { force: true });
fs.writeFileSync(path.join(VOL_DIR, '.seed-version'), String(seedVer) + '\n');
console.log(`[seed] complete: ${fs.readdirSync(VOL_DIR).join(' ')}`);
