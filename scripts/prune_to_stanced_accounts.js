import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const STANCES = JSON.parse(`{"adam3us":"against","mandrik":"against","theonevortex":"against","udiwertheimer":"against","kloaec":"against","stephanlivera":"against","giacomozucco":"neutral","zndtoshi":"against","mrhodl":"against","grassfedbitcoin":"approve","_checkmatey_":"against","w_s_bitcoin":"against","sashahodler":"against","hodlonaut":"approve","lukedashjr":"approve","jimmysong":"neutral","reardencode":"against","cguida6":"approve","bitmexresearch":"against","mattkratter":"approve","lukedewolf":"approve","aeonbtc":"against","mikeinspace":"against","knutsvanholm":"approve","conza":"approve","beautyon_":"approve","hodlmagoo":"against","boomer_btc":"approve","vladcostea":"against","bitcoinmotorist":"approve","bigseanharris":"approve","rob1ham":"against","rodpalmerhodl":"against","bitcoinallcaps":"approve","callebtc":"against","theinstagibbs":"against","theguyswann":"approve","btctooblivion":"approve","supertestnet":"neutral","r0ckstardev":"against","murchandamus":"against","1914ad":"approve","btcpadre":"against","btcsessions":"neutral","_pyblock_":"approve","owenkemeys":"against","hodling_btc":"neutral","ghostofwhitman":"against","benjustman":"neutral","arthur_van_pelt":"approve","mbitcoiner":"approve","djsenior13":"approve","hodldee":"against","fundamentals21m":"neutral","melvincarvalho":"approve","ghostofstoneyx2":"approve","bramk":"neutral","bitbello":"approve","sovtoshi":"against","ben_dewaal":"against","teddybitcoins":"against","niftynei":"approve","bradmillscan":"against","oomahq":"approve","walkeramerica":"against","simondixontwitt":"neutral","aantonop":"against","pete_rizzo_":"against","peterktodd":"against","nvk":"against","tonevays":"against","rodarmor":"against","lifofifo":"against","mononautical":"against","truthcoin":"against","lopp":"against","achow101":"against","1440000bytes":"against","elinagar":"against","bankydatanky":"neutral","bill_fowler_":"against","fulltimebitcoin":"against","brian_trollz":"against","adelgary":"against","arshbot":"neutral","coincornerdanny":"against","parman_the":"approve","heavilyarmedc":"against","adamsimecka":"approve","yungguccit":"against","nithusezni":"approve","jyn_urso":"against","odellxyz":"against","tomerstrolight":"approve","fieldnas":"approve","orangesurfbtc":"against","bamskki":"approve","marsspitsbarz":"against","toxikat27":"against","gustavojfe":"against","kristiancsep":"against","orthodoxbitcoin":"against","midmagic":"against","joenakamoto":"neutral","mutatrum":"against","pakovm":"against","l0rinc":"against","bitcoinscoresby":"against","ts_hodl":"neutral","bitcoinapolis55":"approve","darosior":"against","stackingsaunter":"against","btcinfinityshow":"approve","dathon_ohm":"approve","davidbranscum":"approve","spoonmvn":"against","dudejlebowski":"approve","omg21btc":"approve","simplestbtcbook":"approve","btcspeedboat":"against","guerillav2":"against","princey21m":"approve","2140data":"approve","matteopelleg":"approve","sgbarbour":"against","21milinfinity":"against","itsliran":"against","bitcoinbombadil":"approve","stevesimple":"approve","llfourn":"approve","kixunil":"against","predyx_markets":"neutral","stutxo":"against","leplebroyale":"against","tronmongone":"against","justalillybit":"approve","seantoshii":"approve","bitcoinbeachbr":"approve","btc_for_freedom":"approve","bitschmidty":"neutral","nodenationsv":"approve","ndeet":"against","needcreations":"approve","roger__9000":"approve","bitcoin_bugle":"against","asanoha_gold":"approve","kanemcgukin":"approve","btcpins":"neutral","stromens":"neutral","proofofcash":"against","nickszabo4":"approve"}`);

const accountsMasterPath = path.join(root, "public", "data", "accounts_master.json");
const accountsStancedPath = path.join(root, "public", "data", "accounts_stanced.json");
const mentionsPath = path.join(root, "public", "data", "mentions_bip110.csv");
const avatarsDir = path.join(root, "public", "avatars");
const oldAccountsCsv = path.join(root, "public", "data", "top1000_bitcoiners.csv");
const oldExtraJson = path.join(root, "public", "accounts_extra.json");

function norm(h) {
  return String(h ?? "").trim().toLowerCase();
}

async function main() {
  const accounts = JSON.parse(await fs.readFile(accountsMasterPath, "utf-8"));
  const stanceMap = new Map(Object.entries(STANCES).map(([k, v]) => [norm(k), String(v)]));

  const byHandle = new Map(accounts.map((a) => [norm(a.handle), a]));
  const out = [];
  for (const [handle, stance] of stanceMap.entries()) {
    const existing = byHandle.get(handle) ?? {};
    out.push({
      ...existing,
      handle,
      stance,
      followers_count: Number(existing.followers_count ?? 0) || 0,
      avatar_path: existing.avatar_path || `/avatars/${handle}.jpg`,
    });
  }
  out.sort((a, b) => (Number(b.followers_count || 0) - Number(a.followers_count || 0)));

  await fs.writeFile(accountsStancedPath, JSON.stringify(out, null, 2) + "\n", "utf-8");
  await fs.writeFile(accountsMasterPath, JSON.stringify(out, null, 2) + "\n", "utf-8");

  // Keep only tweets for stanced handles
  const mentionsRaw = await fs.readFile(mentionsPath, "utf-8");
  const parsed = Papa.parse(mentionsRaw, { header: true, skipEmptyLines: true });
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  const filtered = rows.filter((r) => stanceMap.has(norm(r.handle)));
  const mentionsCsv = Papa.unparse(filtered, { header: true });
  await fs.writeFile(mentionsPath, mentionsCsv + "\n", "utf-8");

  // Delete avatars not belonging to stanced handles
  const keepAvatarPaths = new Set(out.map((a) => String(a.avatar_path || "").replace(/^\/+/, "").toLowerCase()));
  keepAvatarPaths.add("avatars/_missing.svg");
  const avatarFiles = await fs.readdir(avatarsDir).catch(() => []);
  let deleted = 0;
  for (const file of avatarFiles) {
    const rel = `avatars/${file}`.toLowerCase();
    if (!keepAvatarPaths.has(rel)) {
      await fs.unlink(path.join(avatarsDir, file)).catch(() => {});
      deleted++;
    }
  }

  // Remove old source datasets
  await fs.unlink(oldAccountsCsv).catch(() => {});
  await fs.unlink(oldExtraJson).catch(() => {});

  console.log(`Stanced accounts kept: ${out.length}`);
  console.log(`Mentions kept: ${filtered.length}`);
  console.log(`Avatars deleted: ${deleted}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
