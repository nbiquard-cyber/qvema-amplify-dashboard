// QVEMA Amplify — Feature Liz · extraction de texte des documents Drive.
// Lit le contenu texte des .docx et .xlsx (qui sont des archives ZIP) sans
// dépendance externe (ZIP + zlib inflate). Les fichiers Google-natifs sont
// gérés en amont par export (text/plain, text/csv). PDF : non extrait pour
// l'instant (retour vide + note).

const zlib = require("zlib");

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// Lit les entrées d'un ZIP via son répertoire central. Renvoie { name: Buffer }.
function readZip(buf) {
  const entries = {};
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error("ZIP invalide (EOCD introuvable)");
  const cdCount = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    try {
      entries[name] = method === 0 ? comp : method === 8 ? zlib.inflateRawSync(comp) : Buffer.alloc(0);
    } catch (_) {
      entries[name] = Buffer.alloc(0);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function docxText(buf) {
  const entries = readZip(buf);
  const xml = entries["word/document.xml"] ? entries["word/document.xml"].toString("utf8") : "";
  const withBreaks = xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab[^>]*\/?>/g, "\t")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks).replace(/\n{3,}/g, "\n\n").trim();
}

function xlsxText(buf) {
  const entries = readZip(buf);
  const ssXml = entries["xl/sharedStrings.xml"] ? entries["xl/sharedStrings.xml"].toString("utf8") : "";
  const shared = [];
  ssXml.replace(/<si>([\s\S]*?)<\/si>/g, (_, si) => {
    let s = "";
    si.replace(/<t[^>]*>([\s\S]*?)<\/t>/g, (__, t) => ((s += t), ""));
    shared.push(decodeEntities(s));
    return "";
  });
  const sheetKeys = Object.keys(entries)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort();
  const out = [];
  for (const k of sheetKeys) {
    const xml = entries[k].toString("utf8");
    const rows = [];
    xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, row) => {
      const cells = [];
      row.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (__, attrs, inner) => {
        const type = (attrs.match(/\bt="([^"]*)"/) || [])[1] || "";
        let val = "";
        if (type === "inlineStr") {
          const im = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = im ? decodeEntities(im[1]) : "";
        } else {
          const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = vm ? decodeEntities(vm[1]) : "";
          if (type === "s" && val !== "") val = shared[Number(val)] || "";
        }
        cells.push(val);
        return "";
      });
      if (cells.some((c) => c !== "")) rows.push(cells.join(" | "));
      return "";
    });
    if (rows.length) out.push((sheetKeys.length > 1 ? `# Feuille ${sheetKeys.indexOf(k) + 1}\n` : "") + rows.join("\n"));
  }
  return out.join("\n\n").trim();
}

// Extrait le texte d'un fichier selon son type. `buf` = contenu binaire.
function extractText(name, mimeType, buf) {
  const lower = (name || "").toLowerCase();
  const mt = mimeType || "";
  try {
    if (lower.endsWith(".docx") || mt.includes("wordprocessingml")) return docxText(buf);
    if (lower.endsWith(".xlsx") || mt.includes("spreadsheetml")) return xlsxText(buf);
    if (lower.endsWith(".csv") || lower.endsWith(".txt") || mt.startsWith("text/")) return buf.toString("utf8");
    if (lower.endsWith(".pdf") || mt.includes("pdf")) return "[PDF non extrait automatiquement — convertir en Google Doc pour l'inclure]";
  } catch (e) {
    return `[extraction impossible : ${String((e && e.message) || e)}]`;
  }
  return "";
}

module.exports = { extractText, docxText, xlsxText, readZip };
