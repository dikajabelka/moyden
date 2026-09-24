/* Админка «Картинки Мой день».
   Работает прямо в браузере через GitHub API: кладёт картинки в папку «новые» и словарь,
   дальше GitHub сам запускает build.py и публикует сайт (.github/workflows/publish.yml). */
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm = s => (s || "").normalize("NFC").toLowerCase().replace(/ё/g, "е").replace(/[\s_\-]+/g, " ").trim();
const API = "https://api.github.com";
const VARIANTS = ["девочка", "мальчик", "без людей"];
const DICT_HEAD = ["категория", "слово", "варианты", "теги", "комментарий"];
const MAXSIDE = 1024;   // до такого размера уменьшаем в браузере перед загрузкой (окончательно — 512 на GitHub)

let S = {token: "", owner: "", repo: "", branch: "main"};
let DICT = [], DIDX = new Map(), CAT = {items: [], categories: []}, CATS = [], META = new Map();

/* ================= GitHub API ================= */
async function gh(path, opt = {}){
  const r = await fetch(API + path, {
    ...opt, cache: "no-store",
    headers: {"Authorization": "Bearer " + S.token, "Accept": opt.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", ...(opt.body ? {"Content-Type": "application/json"} : {})},
  });
  if (!r.ok){
    let msg = r.status + "";
    try { msg += " " + (await r.json()).message; } catch (e) {}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  if (r.status === 204) return null;
  return opt.raw ? r.text() : r.json();
}
const repoPath = p => `/repos/${S.owner}/${S.repo}` + p;
const encPath = p => p.split("/").map(encodeURIComponent).join("/");

async function readText(path){
  try { return await gh(repoPath(`/contents/${encPath(path)}?ref=${S.branch}`), {raw: true}); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

function b64FromBytes(u8){
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64FromText = t => b64FromBytes(new TextEncoder().encode(t));

/* Один коммит с несколькими файлами. files: [{path, b64}] или {path, del:true} */
async function commit(files, message){
  const blobs = [];
  for (const f of files){
    if (f.del){ blobs.push({path: f.path, mode: "100644", type: "blob", sha: null}); continue; }
    const b = await gh(repoPath("/git/blobs"), {method: "POST", body: JSON.stringify({content: f.b64, encoding: "base64"})});
    blobs.push({path: f.path, mode: "100644", type: "blob", sha: b.sha});
  }
  for (let attempt = 0; attempt < 4; attempt++){
    const ref = await gh(repoPath(`/git/ref/heads/${S.branch}`));
    const base = await gh(repoPath(`/git/commits/${ref.object.sha}`));
    const tree = await gh(repoPath("/git/trees"), {method: "POST", body: JSON.stringify({base_tree: base.tree.sha, tree: blobs})});
    const c = await gh(repoPath("/git/commits"), {method: "POST",
      body: JSON.stringify({message, tree: tree.sha, parents: [ref.object.sha]})});
    try {
      await gh(repoPath(`/git/refs/heads/${S.branch}`), {method: "PATCH", body: JSON.stringify({sha: c.sha})});
      return c.sha;
    } catch (e) {
      if (e.status !== 422 || attempt === 3) throw e;       // сборщик успел закоммитить — повторяем
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

/* ================= вход ================= */
function guessRepo(){
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return "";
  const first = location.pathname.split("/").filter(Boolean)[0];
  return m[1] + "/" + (first && !first.endsWith(".html") ? first : m[1] + ".github.io");
}

async function login(token, repo){
  const [owner, name] = repo.trim().replace(/^https?:\/\/github\.com\//, "").split("/");
  if (!owner || !name) throw new Error("Укажите репозиторий в виде имя/название");
  S = {token: token.trim(), owner, repo: name, branch: "main"};
  const info = await gh(`/repos/${owner}/${name}`);
  S.branch = info.default_branch || "main";
  if (!info.permissions || !info.permissions.push) throw new Error("У ключа нет права записи в этот репозиторий");
  localStorage.setItem("mojden.admin", JSON.stringify(S));
}

$("lgo").onclick = async () => {
  $("lerr").textContent = "";
  $("lgo").disabled = true;
  try { await login($("ltoken").value, $("lrepo").value); start(); }
  catch (e) {
    $("lerr").textContent = e.status === 401 ? "Ключ не подходит (неверный или просрочен)." :
      e.status === 404 ? "Репозиторий не найден или ключ к нему не имеет доступа." : e.message;
  }
  $("lgo").disabled = false;
};
$("logout").onclick = e => { e.preventDefault(); localStorage.removeItem("mojden.admin"); location.reload(); };

(function boot(){
  try { S = JSON.parse(localStorage.getItem("mojden.admin")) || S; } catch (e) {}
  if (S.token){ start(); return; }
  $("lrepo").value = guessRepo();
  $("login").hidden = false;
})();

async function start(){
  $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false;
  $("actlink").href = `https://github.com/${S.owner}/${S.repo}/actions`;
  try { await loadData(); }
  catch (e) {
    if (e.status === 401){ localStorage.removeItem("mojden.admin"); location.reload(); return; }
    status("err", "Не удалось загрузить данные: " + esc(e.message));
  }
  watchRuns();
}

/* ================= данные ================= */
function parseCSV(text){
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const d = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ";" : ",";
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"' && text[i + 1] === '"'){ cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d){ row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r"){
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur || row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function toCSV(rows){
  const f = v => /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  return "\uFEFF" + [DICT_HEAD, ...rows.map(r => DICT_HEAD.map(k => r[k] || ""))]
    .map(r => r.map(x => f(String(x))).join(";")).join("\r\n") + "\r\n";
}

async function loadData(){
  const [dict, cat, meta] = await Promise.all([readText("словарь.csv"), readText("catalog.json"), readText("картинки.csv")]);
  META = new Map();
  for (const r of parseCSV(meta || "")){
    if (norm(r[0]) === "файл" || !r[0]) continue;
    META.set(r[0].trim().normalize("NFC"), {"файл": r[0].trim().normalize("NFC"), "слово": (r[1] || "").trim(), "вариант": (r[2] || "").trim(), "стиль": (r[3] || "").trim()});
  }
  DICT = [];
  for (const r of parseCSV(dict || "")){
    if (norm(r[0]) === "категория") continue;
    const o = {}; DICT_HEAD.forEach((k, i) => o[k] = (r[i] || "").trim().normalize("NFC"));
    if (o["слово"]) DICT.push(o);
  }
  reindex();
  CAT = cat ? JSON.parse(cat) : {items: [], categories: []};
  CAT.items.forEach(i => { i.variant = i.variant || ""; i.style = i.style || "рисунок"; i.n = i.n || 1; });
  renderQueue(); renderLib(); renderDict(); loadReport();
}
function reindex(){
  DIDX = new Map(DICT.map(r => [norm(r["слово"]), r]));
  CATS = [...new Set([...DICT.flatMap(rowCats), ...(CAT.categories || [])].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  let dl = $("words");
  if (!dl){ dl = document.createElement("datalist"); dl.id = "words"; document.body.appendChild(dl); }
  dl.innerHTML = DICT.map(r => `<option value="${esc(r["слово"])}">`).join("");
}
const rowVariants = r => {
  const v = (r["варианты"] || "").split(",").map(norm);
  const out = VARIANTS.filter(x => v.includes(norm(x)));
  return out.length ? out : ["девочка", "мальчик"];
};
const rowCats = r => [...new Set((r["категория"] || "").split(/[,;]/).map(c => c.trim().toLowerCase()).filter(Boolean))];
const rowTags = r => [...new Set((r["теги"] || "").split(/[,;]/).map(c => c.trim().toLowerCase()).filter(Boolean))];
const onlyNoPeople = r => { const v = rowVariants(r); return v.length === 1 && v[0] === "без людей"; };
const itemsOf = word => CAT.items.filter(i => norm(i.word || i.title) === norm(word));

/* разбор имени файла — так же, как в build.py */
function parseName(stem){
  const raw = stem.normalize("NFC").toLowerCase().replace(/[\s_\-]+/g, " ").trim().split(" ");
  const t = raw.map(x => x.replace(/ё/g, "е"));
  let variant = "", style = "рисунок", n = 1;
  while (t.length > 1){
    const x = t[t.length - 1];
    if (/^\d+$/.test(x) && n === 1) n = +x;
    else if (x === "фото") style = "фото";
    else if (x === "рисунок") {}
    else if ((x === "девочка" || x === "мальчик") && !variant) variant = x;
    else if (t.length > 2 && t[t.length - 2] === "без" && x === "людей" && !variant){ variant = "без людей"; t.pop(); raw.pop(); }
    else break;
    t.pop(); raw.pop();
  }
  return {word: raw.join(" "), variant, style, n};
}

/* ================= статус сборки ================= */
function status(kind, html){
  $("gstatus").innerHTML = html ? `<div class="status ${kind}">${kind === "run" ? '<span class="spin"></span>' : ""}<span>${html}</span></div>` : "";
}
let watching = null;
async function watchRuns(sha){
  clearTimeout(watching);
  try {
    const r = await gh(repoPath(`/actions/runs?branch=${S.branch}&per_page=5`));
    const runs = r.workflow_runs || [];
    const run = sha ? runs.find(x => x.head_sha === sha) : runs[0];
    if (sha && !run){ status("run", "Загружено. Ждём, когда GitHub начнёт сборку…"); watching = setTimeout(() => watchRuns(sha), 4000); return; }
    if (!run){ status("", ""); return; }
    if (run.status !== "completed"){
      status("run", "Сайт собирается и публикуется… обычно 1–2 минуты. Можно закрыть страницу — всё доделается само.");
      watching = setTimeout(() => watchRuns(sha || run.head_sha), 5000);
      return;
    }
    if (run.conclusion === "success"){
      if (sha){ status("ok", "✓ Готово! Сайт обновлён. <a href='index.html' target='_blank'>Открыть сайт</a> (если не видно — обновите страницу через минуту)"); await loadData(); }
      else status("", "");
    } else {
      status("err", `Сборка не удалась. <a href="${esc(run.html_url)}" target="_blank">Подробности</a> — пришлите скриншот в чат.`);
    }
  } catch (e) {
    if (e.status === 403) status("", "");        // у ключа нет права читать Actions — просто не показываем
  }
}

/* ================= вкладки ================= */
$("tabs").onclick = e => {
  const b = e.target.closest(".tab"); if (!b) return;
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll("main section").forEach(s => s.classList.toggle("on", s.id === "s-" + b.dataset.t));
};
function showTab(t){ document.querySelector(`.tab[data-t="${t}"]`).click(); }

/* ================= ДОБАВИТЬ ================= */
let Q = [], qid = 0;
const drop = $("drop");
drop.onclick = () => $("file").click();
$("file").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => addFiles([...e.dataTransfer.files]));
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => e.preventDefault());

function addFiles(files, preset){
  for (const f of files){
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)){
      alert(`«${f.name}» — такой формат не подходит. Нужны PNG, JPG, WEBP или SVG.`); continue;
    }
    const p = preset || parseName(f.name.replace(/\.[^.]+$/, ""));
    const row = DIDX.get(norm(p.word));
    if (!row && !preset) p.n = 1;             // IMG_2031 — это не номер варианта
    const it = {id: ++qid, file: f, ext, url: URL.createObjectURL(f),
      word: row ? row["слово"] : (preset ? p.word : (/^(img|image|photo|dsc|screenshot|снимок)/i.test(p.word) ? "" : p.word)),
      variant: p.variant, style: p.style, n: p.n || 1, replaceFile: preset && preset.replaceFile || "",
      replaceLabel: preset && preset.replaceLabel || "",
      newCat: "", catSel: "", newCatName: "", newTags: "", newVariants: ""};
    if (row && !it.variant && onlyNoPeople(row)) it.variant = "без людей";
    Q.push(it);
  }
  renderQueue();
  if (files.length) showTab("add");
}

/* проверка одной строки очереди */
function check(it, idx){
  const r = {ok: false, msg: "", cls: "err", isNew: false};
  if (it.replaceFile){
    r.ok = true; r.cls = "good";
    r.msg = `✓ Заменит картинку «${cap(it.word)}${it.replaceLabel ? " · " + it.replaceLabel : ""}». Адрес останется прежним.`;
    return r;
  }
  if (!it.word.trim()){ r.msg = "Впишите слово — какая это картинка."; return r; }
  const row = DIDX.get(norm(it.word));
  r.isNew = !row;
  if (r.isNew && !it.newCat.trim()){ r.msg = it.catSel === "__new" ? "Впишите название новой категории." : "Нового слова нет в словаре — выберите категорию ниже."; r.cls = "warn"; return r; }
  const needPeople = row ? !onlyNoPeople(row) : (it.newVariants || "девочка, мальчик") !== "без людей";
  if (!it.variant && !needPeople) it.variant = "без людей";
  if (!it.variant && needPeople){ r.msg = "Выберите, кто на картинке."; r.cls = "warn"; return r; }
  // номер варианта: первый свободный (в каталоге и выше в очереди)
  const same = x => norm(x.word) === norm(it.word) && (x.variant || "") === (it.variant || "") && x.style === it.style;
  const taken = new Set(itemsOf(it.word).filter(same).map(x => x.n));
  Q.slice(0, idx).filter(x => !x.replaceFile).filter(same).forEach(x => taken.add(x.finalN));
  let n = 1; while (taken.has(n)) n++;
  it.finalN = n;
  const cat = row ? rowCats(row).join(", ") : it.newCat;
  const label = [it.variant, it.style === "фото" ? "фото" : "", n > 1 ? "№" + n : ""].filter(Boolean).join(", ");
  r.ok = true; r.cls = "good";
  r.msg = `✓ «${cap(it.word.trim())}» → ${cat}${label ? ", " + label : ""}` +
    (n > 1 ? " — ещё один вариант" : "") + (r.isNew ? " · новое слово" : "");
  return r;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* все категории: из словаря + новые, придуманные в этой загрузке */
function allCats(){
  const extra = Q.filter(x => x.catSel === "__new" && x.newCatName.trim()).map(x => x.newCatName.trim().toLowerCase());
  return [...new Set([...CATS, ...extra])].sort((a, b) => a.localeCompare(b, "ru"));
}
function syncCat(it){ it.newCat = it.catSel === "__new" ? it.newCatName.trim().toLowerCase() : (it.catSel || ""); }

function catBlock(it){
  const cats = allCats();
  return `<label class="f">Категория</label>
    <select data-k="catSel">
      <option value="" ${!it.catSel ? "selected" : ""}>— выберите —</option>
      ${cats.map(c => `<option value="${esc(c)}" ${it.catSel === c ? "selected" : ""}>${esc(cap(c))}</option>`).join("")}
      <option value="__new" ${it.catSel === "__new" ? "selected" : ""}>➕ Новая категория…</option>
    </select>
    ${it.catSel === "__new" ? `<input type="text" data-k="newCatName" value="${esc(it.newCatName)}"
        placeholder="Название, например: праздники" style="margin-top:6px" autocomplete="off">
      <div class="muted" style="font-size:12px;margin-top:3px">Новая категория появится на сайте после загрузки.</div>` : ""}
    <div class="muted" style="font-size:12px;margin-top:3px">Ещё категории можно добавить потом — в карточке слова.</div>`;
}

function renderQueue(){
  const box = $("queue");
  box.innerHTML = "";
  Q.forEach((it, idx) => {
    it.catSel = it.catSel || ""; it.newCatName = it.newCatName || ""; syncCat(it);
    const c = check(it, idx);
    const d = document.createElement("div");
    d.className = "q " + (c.ok ? "ok" : "bad");
    d.dataset.sig = sig(c, it);
    const vopts = [["девочка", "👧 Девочка"], ["мальчик", "👦 Мальчик"], ["без людей", "Без людей"]];
    d.innerHTML = `<img src="${it.url}" alt="">
      <div>
        ${it.replaceFile ? `<b>${esc(cap(it.word))}</b> <span class="muted">· замена</span>` : `
        <input type="text" list="words" value="${esc(it.word)}" placeholder="Слово: чистить зубы" data-k="word" autocomplete="off">
        <div class="segs">${vopts.map(([v, l]) => `<button class="sg ${it.variant === v ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}
          <button class="sg ${it.style === "фото" ? "on" : ""}" data-s="1">📷 Фото</button></div>`}
        ${c.isNew && it.word.trim() && !it.replaceFile ? `<div class="newword"><b>Новое слово.</b> Оно добавится в словарь.
          <div class="row2"><div>${catBlock(it)}</div>
          <div><label class="f">Какие картинки нужны</label><select data-k="newVariants">
            ${["девочка, мальчик", "без людей", "девочка, мальчик, без людей"].map(v =>
              `<option ${(it.newVariants || "девочка, мальчик") === v ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
          <label class="f">Синонимы для поиска (через запятую)</label>
          <input type="text" value="${esc(it.newTags)}" placeholder="например: прыгать, батут" data-k="newTags" autocomplete="off"></div>` : ""}
        <div class="st ${c.cls}">${esc(c.msg)}</div>
      </div>
      <button class="rm" title="Убрать">✕</button>`;

    // текстовые поля: пока печатаешь — карточка НЕ перерисовывается, обновляется только подсказка
    d.querySelectorAll("input[data-k]").forEach(inp => {
      inp.oninput = () => {
        it[inp.dataset.k] = inp.value;
        if (inp.dataset.k === "word"){
          const r2 = DIDX.get(norm(inp.value));
          if (r2 && onlyNoPeople(r2) && !it.variant) it.variant = "без людей";
        }
        syncCat(it);
        refresh();
      };
      inp.onchange = () => {
        if (inp.dataset.k === "newCatName") return renderQueue();      // чтобы новая категория появилась в списках
        if (sig(check(it, idx), it) !== d.dataset.sig) renderQueue();
      };
      inp.onkeydown = e => { if (e.key === "Enter"){ e.preventDefault(); inp.blur(); } };
    });
    d.querySelectorAll("select[data-k]").forEach(sel => sel.onchange = () => {
      it[sel.dataset.k] = sel.value; syncCat(it); renderQueue();
      if (sel.dataset.k === "catSel" && sel.value === "__new")
        setTimeout(() => $("queue").children[idx]?.querySelector('[data-k="newCatName"]')?.focus(), 0);
    });
    d.querySelectorAll("[data-v]").forEach(b => b.onclick = () => { it.variant = it.variant === b.dataset.v ? "" : b.dataset.v; renderQueue(); });
    d.querySelector("[data-s]")?.addEventListener("click", () => { it.style = it.style === "фото" ? "рисунок" : "фото"; renderQueue(); });
    d.querySelector(".rm").onclick = () => { URL.revokeObjectURL(it.url); Q.splice(idx, 1); renderQueue(); };
    box.appendChild(d);
  });
  $("gowrap").hidden = !Q.length;
  refresh();
}
function sig(c, it){ return String(c.isNew && !!it.word.trim()); }

/* обновить подсказки и кнопку, не трогая поля ввода */
function refresh(){
  let allOk = Q.length > 0;
  [...$("queue").children].forEach((d, idx) => {
    const it = Q[idx]; if (!it) return;
    const c = check(it, idx);
    allOk = allOk && c.ok;
    d.className = "q " + (c.ok ? "ok" : "bad");
    const st = d.querySelector(".st");
    st.className = "st " + c.cls; st.textContent = c.msg;
  });
  $("go").disabled = !allOk;
  $("go").textContent = allOk ? `Загрузить ${Q.length} ${plural(Q.length, "картинку", "картинки", "картинок")} на сайт`
    : "Заполните отмеченные карточки";
}
function plural(n, a, b, c){ const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; }

/* уменьшение в браузере до 1024 — чтобы не грузить 10-мегабайтные фото */
function shrink(it){
  return new Promise(res => {
    if (it.ext === "svg") return it.file.arrayBuffer().then(b => res({bytes: new Uint8Array(b), ext: "svg"}));
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAXSIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const keep = k === 1 && ["png", "jpg", "jpeg", "webp"].includes(it.ext);
      if (keep) return it.file.arrayBuffer().then(b => res({bytes: new Uint8Array(b), ext: it.ext === "jpeg" ? "jpg" : it.ext}));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const asPng = it.ext === "png" || it.ext === "gif";
      c.toBlob(b => b.arrayBuffer().then(buf => res({bytes: new Uint8Array(buf), ext: asPng ? "png" : "jpg"})),
        asPng ? "image/png" : "image/jpeg", 0.92);
    };
    img.onerror = () => it.file.arrayBuffer().then(b => res({bytes: new Uint8Array(b), ext: it.ext}));
    img.src = it.url;
  });
}

$("go").onclick = async () => {
  const btn = $("go"); btn.disabled = true; btn.textContent = "Загружаю…";
  try {
    const files = [];
    let dictChanged = false;
    for (let i = 0; i < Q.length; i++){
      const it = Q[i];
      check(it, i);
      const {bytes, ext} = await shrink(it);
      if (it.replaceFile){
        const rel = it.replaceFile.replace(/^images\//, "").replace(/\.[^.\/]+$/, "");
        files.push({path: `новые/_заменить/${rel}.${ext}`, b64: b64FromBytes(bytes)});
      } else {
        const w = it.word.trim().toLowerCase().normalize("NFC");
        if (!DIDX.get(norm(w))){
          DICT.push({"категория": it.newCat.trim().toLowerCase(), "слово": w,
            "варианты": it.newVariants || "девочка, мальчик", "теги": it.newTags.trim(), "комментарий": "добавлено из админки"});
          reindex(); dictChanged = true;
        }
        const name = [w, it.variant, it.style === "фото" ? "фото" : "", it.finalN > 1 ? it.finalN : ""].filter(Boolean).join(" ");
        files.push({path: `новые/${name}.${ext}`, b64: b64FromBytes(bytes)});
      }
      btn.textContent = `Готовлю ${i + 1} из ${Q.length}…`;
    }
    if (dictChanged) files.push({path: "словарь.csv", b64: b64FromText(toCSV(DICT))});
    btn.textContent = "Отправляю на GitHub…";
    const sha = await commit(files, `Админка: ${Q.length} ${plural(Q.length, "картинка", "картинки", "картинок")}`);
    Q.forEach(it => URL.revokeObjectURL(it.url));
    Q = []; renderQueue();
    watchRuns(sha);
  } catch (e) {
    alert("Не получилось загрузить: " + e.message);
    renderQueue();
  }
};

/* ================= КАРТИНКИ И ПЛАН ================= */
let libFilter = "";
function renderLib(){
  const q = norm($("libq").value);
  let need = 0, done = 0;
  const byCat = new Map();
  for (const r of DICT){
    const its = itemsOf(r["слово"]);
    const vs = rowVariants(r);
    const miss = vs.filter(v => !its.some(i => i.variant === v));
    need += vs.length; done += vs.length - miss.length;
    if (q && !norm(r["слово"] + " " + r["теги"] + " " + r["категория"]).includes(q)) continue;
    if (libFilter === "miss" && !miss.length) continue;
    if (libFilter === "empty" && its.length) continue;
    if (libFilter === "done" && miss.length) continue;
    const c = rowCats(r)[0] || "без категории";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push({r, its, miss});
  }
  $("libsum").innerHTML = `<b>Нарисовано ${done} из ${need}</b> нужных вариантов · картинок на сайте: ${CAT.items.length}`;
  $("libprog").style.width = (need ? Math.round(100 * done / need) : 0) + "%";
  $("libf").innerHTML = [["", "Все слова"], ["miss", "Чего-то не хватает"], ["empty", "Совсем нет картинок"], ["done", "Готовые"]]
    .map(([v, l]) => `<button class="sg ${libFilter === v ? "on" : ""}" data-f="${v}">${l}</button>`).join("")
    + `<button class="sg" id="libnew" style="margin-left:auto">+ Новое слово</button>`;
  $("libf").querySelectorAll("[data-f]").forEach(b => b.onclick = () => { libFilter = b.dataset.f; renderLib(); });
  $("libnew").onclick = () => openEditor(null);

  const box = $("lib"); box.innerHTML = "";
  for (const [c, list] of [...byCat].sort((a, b) => a[0].localeCompare(b[0], "ru"))){
    const h = document.createElement("h3"); h.className = "lib-cat"; h.textContent = cap(c); box.appendChild(h);
    for (const {r, its, miss} of list){
      const d = document.createElement("div"); d.className = "w";
      const cats = rowCats(r);
      d.innerHTML = `<div class="h"><b>${esc(cap(r["слово"]))}</b>
          <button class="edit" title="Изменить карточку">✎ Изменить</button></div>
        <div class="meta">${cats.length > 1 ? `<span class="cc">${cats.map(x => esc(cap(x))).join(" · ")}</span>` : ""}
          ${r["теги"] ? `<span class="muted">${esc(r["теги"])}</span>` : `<span class="muted" style="color:#C9A227">нет синонимов</span>`}</div>
        <div class="thumbs">
          ${its.map(i => `<div class="th" data-id="${esc(i.id)}"><img src="${esc(i.file)}" loading="lazy" alt="">${esc(vlabel(i))}</div>`).join("")}
          ${miss.map(v => `<div class="miss" data-v="${esc(v)}"><i>+</i>${esc(v)}</div>`).join("")}
          <div class="miss more-add" data-v=""><i>+</i>ещё</div>
        </div>`;
      d.querySelector(".edit").onclick = () => openEditor(r);
      d.querySelectorAll(".th").forEach(t => t.onclick = () => openEditor(r, t.dataset.id));
      d.querySelectorAll(".miss").forEach(m => m.onclick = () => pickFor(r, m.dataset.v));
      box.appendChild(d);
    }
  }
  if (!byCat.size) box.innerHTML = '<p class="muted">Ничего не найдено.</p>';
}
$("libq").oninput = () => { clearTimeout(renderLib.t); renderLib.t = setTimeout(renderLib, 200); };
const vlabel = i => [i.variant, i.style === "фото" ? "фото" : "", i.n > 1 ? i.n : ""].filter(Boolean).join(" ") || "без варианта";

/* выбрать файл: новая картинка для слова или замена конкретной */
function pickFor(r, variant, item){
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg";
  inp.multiple = !item;
  inp.onchange = () => {
    [...inp.files].forEach(f => addFiles([f], item
      ? {word: r["слово"], variant: item.variant, style: item.style, n: item.n, replaceFile: item.file, replaceLabel: vlabel(item)}
      : {word: r["слово"], variant: variant || (onlyNoPeople(r) ? "без людей" : ""), style: "рисунок", n: 1}));
  };
  inp.click();
}

/* ================= КАРТОЧКА СЛОВА (редактор) ================= */
function openEditor(row, focusId){
  const isNew = !row;
  const origWord = row ? row["слово"] : "";
  const e = {word: origWord, cats: row ? rowCats(row) : [], tags: row ? rowTags(row) : [],
    variants: row ? rowVariants(row) : ["девочка", "мальчик"]};
  const its = row ? itemsOf(origWord) : [];
  const ed = new Map(its.map(i => [i.file, {variant: i.variant, style: i.style, del: false}]));
  const m = document.createElement("div"); m.className = "menu";
  let dirty = false;
  const close = () => { if (!dirty || confirm("Закрыть без сохранения?")) m.remove(); };

  let drawing = false;
  const draw = (focus) => {
    if (drawing) return;
    drawing = true;
    const ae = document.activeElement; if (ae && m.contains(ae)) ae.onblur = null;
    try { drawInner(focus); } finally { drawing = false; }
  };
  const drawInner = (focus) => {
    const other = allCats().filter(c => !e.cats.includes(c));
    m.innerHTML = `<div class="edbox">
      <button class="dx" data-a="x" aria-label="Закрыть">✕</button>
      <h3 style="text-align:left">${isNew ? "Новое слово" : "Карточка «" + esc(cap(origWord)) + "»"}</h3>
      <label class="f">Слово — подпись на карточке</label>
      <input type="text" id="e-word" value="${esc(e.word)}" placeholder="например: чистить зубы" autocomplete="off">
      ${!isNew ? `<div class="muted" style="font-size:12px;margin-top:3px">Можно переименовать. Если впишете слово, которое уже есть, — карточки объединятся.</div>` : ""}

      <label class="f">Категории (первая — основная)</label>
      <div class="chips">
        ${e.cats.map((c, k) => `<span class="chip">${esc(cap(c))}<button data-rc="${k}" aria-label="убрать">×</button></span>`).join("")}
        <select id="e-addcat" class="chipsel"><option value="">+ категория</option>
          ${other.map(c => `<option value="${esc(c)}">${esc(cap(c))}</option>`).join("")}
          <option value="__new">➕ Новая категория…</option></select>
      </div>

      <label class="f">Синонимы для поиска</label>
      <div class="chips">
        ${e.tags.map((t, k) => `<span class="chip t">${esc(t)}<button data-rt="${k}" aria-label="убрать">×</button></span>`).join("")}
        <input type="text" id="e-tag" class="chipin" placeholder="+ синоним, Enter" autocomplete="off">
      </div>

      <label class="f">Какие картинки нужны этому слову</label>
      <div class="segs">${VARIANTS.map(v => `<button class="sg ${e.variants.includes(v) ? "on" : ""}" data-nv="${v}">${e.variants.includes(v) ? "✓ " : ""}${v}</button>`).join("")}</div>

      ${!isNew ? `<label class="f">Картинки (${its.length})</label>
      <div class="edimgs">
        ${its.map(i => { const x = ed.get(i.file); return `<div class="edi ${x.del ? "del" : ""} ${i.id === focusId ? "foc" : ""}" data-f="${esc(i.file)}">
          <img src="${esc(i.file)}" alt="">
          <div style="min-width:0">
            <div class="segs" style="margin-top:0">
              ${[["девочка", "👧 Девочка"], ["мальчик", "👦 Мальчик"], ["без людей", "Без людей"]].map(([v, l]) =>
                `<button class="sg ${x.variant === v ? "on" : ""}" data-iv="${v}">${l}</button>`).join("")}
              <button class="sg ${x.style === "фото" ? "on" : ""}" data-is="1">📷 Фото</button>
            </div>
            <div class="edact">
              <button data-rep="1">Заменить файл</button>
              <a href="${esc(i.file)}" target="_blank">Открыть</a>
              <button data-del="1" class="${x.del ? "" : "red"}">${x.del ? "Вернуть" : "Удалить"}</button>
            </div>
            ${x.del ? `<div class="st err" style="margin-top:4px">Будет удалена при сохранении</div>` : ""}
          </div></div>`; }).join("")}
        <button class="sg" id="e-addimg">+ Добавить картинку</button>
      </div>` : ""}

      <p class="st err" id="e-err"></p>
      <button class="btn" id="e-save">Сохранить</button>
      ${row && !its.length ? `<button class="btn ghost" id="e-delword" style="color:#C0392B">Удалить слово из словаря</button>` : ""}
      <button class="btn ghost" data-a="x">Отмена</button>
    </div>`;

    const q = s => m.querySelector(s);
    q("#e-word").oninput = ev => { e.word = ev.target.value; dirty = true; };
    m.querySelectorAll("[data-rc]").forEach(b => b.onclick = () => { e.cats.splice(+b.dataset.rc, 1); dirty = true; draw(); });
    q("#e-addcat").onchange = ev => {
      let v = ev.target.value;
      if (v === "__new") v = (prompt("Название новой категории:") || "").trim().toLowerCase();
      if (v && !e.cats.includes(v)){ e.cats.push(v); if (!CATS.includes(v)) CATS.push(v); dirty = true; }
      draw();
    };
    const addTag = () => {
      const inp = q("#e-tag");
      const parts = inp.value.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
      parts.forEach(t => { if (!e.tags.includes(t)) e.tags.push(t); });
      if (parts.length){ dirty = true; draw("#e-tag"); }
    };
    q("#e-tag").onkeydown = ev => { if (ev.key === "Enter" || ev.key === ","){ ev.preventDefault(); addTag(); } };
    q("#e-tag").onblur = () => { if (q("#e-tag").value.trim()) addTag(); };
    m.querySelectorAll("[data-rt]").forEach(b => b.onmousedown = ev => ev.preventDefault());
    m.querySelectorAll("[data-rt]").forEach(b => b.onclick = () => { e.tags.splice(+b.dataset.rt, 1); dirty = true; draw(); });
    m.querySelectorAll("[data-nv]").forEach(b => b.onclick = () => {
      const v = b.dataset.nv, k = e.variants.indexOf(v);
      if (k >= 0) e.variants.splice(k, 1); else e.variants.push(v);
      e.variants = VARIANTS.filter(x => e.variants.includes(x)); dirty = true; draw();
    });
    m.querySelectorAll(".edi").forEach(el => {
      const x = ed.get(el.dataset.f), item = its.find(i => i.file === el.dataset.f);
      el.querySelectorAll("[data-iv]").forEach(b => b.onclick = () => { x.variant = x.variant === b.dataset.iv ? "" : b.dataset.iv; dirty = true; draw(); });
      el.querySelector("[data-is]").onclick = () => { x.style = x.style === "фото" ? "рисунок" : "фото"; dirty = true; draw(); };
      el.querySelector("[data-del]").onclick = () => { x.del = !x.del; dirty = true; draw(); };
      el.querySelector("[data-rep]").onclick = () => { m.remove(); pickFor(row, "", item); };
    });
    q("#e-addimg")?.addEventListener("click", () => { m.remove(); pickFor(row, ""); });
    m.querySelectorAll("[data-a=x]").forEach(b => b.onclick = close);
    q("#e-save").onclick = () => saveEditor();
    q("#e-delword")?.addEventListener("click", async () => {
      if (!confirm(`Удалить слово «${origWord}» из словаря?`)) return;
      DICT.splice(DICT.indexOf(row), 1); reindex();
      m.remove(); await saveFiles([], `Админка: удалено слово «${origWord}»`);
    });
    if (focus) q(focus)?.focus();
  };

  async function saveEditor(){
    const err = t => { m.querySelector("#e-err").textContent = t; };
    const t = m.querySelector("#e-tag"); if (t && t.value.trim()){ t.value.split(",").map(x => x.trim().toLowerCase()).filter(Boolean).forEach(x => { if (!e.tags.includes(x)) e.tags.push(x); }); }
    const w = e.word.trim().toLowerCase().normalize("NFC");
    if (!w) return err("Впишите слово.");
    if (!e.cats.length) return err("Добавьте хотя бы одну категорию.");
    if (!e.variants.length) return err("Отметьте, какие картинки нужны (хотя бы одно).");
    const other = DIDX.get(norm(w));
    let target = row;
    if (other && other !== row){
      if (isNew) return err(`Слово «${w}» уже есть в словаре — откройте его карточку.`);
      if (!confirm(`Слово «${w}» уже есть.\n\nОбъединить? Картинки «${origWord}» перейдут к нему, категории и синонимы сложатся.`)) return;
      target = other;
      rowCats(other).forEach(c => { if (!e.cats.includes(c)) e.cats.push(c); });
      rowTags(other).forEach(x => { if (!e.tags.includes(x)) e.tags.push(x); });
      rowVariants(other).forEach(x => { if (!e.variants.includes(x)) e.variants.push(x); });
      DICT.splice(DICT.indexOf(row), 1);
    } else if (isNew){
      target = {"комментарий": "добавлено из админки"}; DICT.push(target);
    }
    target["слово"] = w;
    target["категория"] = e.cats.join(", ");
    target["теги"] = e.tags.join(", ");
    target["варианты"] = VARIANTS.filter(x => e.variants.includes(x)).join(", ");
    reindex();

    const renamed = !isNew && norm(origWord) !== norm(w);
    const files = [];
    let metaChanged = false;
    for (const i of its){
      const x = ed.get(i.file);
      if (x.del){ files.push({path: i.file, del: true}); if (META.delete(i.file)) metaChanged = true; continue; }
      const mm = META.get(i.file) || {"файл": i.file, "слово": "", "вариант": "", "стиль": ""};
      let ch = false;
      if (renamed){ mm["слово"] = w; ch = true; }
      if (x.variant !== i.variant){ mm["вариант"] = x.variant || "-"; ch = true; }
      if (x.style !== i.style){ mm["стиль"] = x.style; ch = true; }
      if (ch){ META.set(i.file, mm); metaChanged = true; }
    }
    if (metaChanged) files.push({path: "картинки.csv", b64: b64FromText(toMetaCSV())});
    m.remove();
    await saveFiles(files, `Админка: карточка «${w}»`);
  }
  draw();
  document.body.appendChild(m);
  m.addEventListener("mousedown", ev => { if (ev.target === m) close(); });
}

async function saveFiles(files, message){
  try {
    files.push({path: "словарь.csv", b64: b64FromText(toCSV(DICT))});
    status("run", "Сохраняю…");
    const sha = await commit(files, message);
    renderLib(); renderDict();
    watchRuns(sha);
  } catch (e) { alert("Не получилось сохранить: " + e.message); await loadData(); }
}

function toMetaCSV(){
  const H = ["файл", "слово", "вариант", "стиль"];
  const f = v => /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const rows = [...META.values()].filter(r => r["слово"] || r["вариант"] || r["стиль"])
    .sort((a, b) => a["файл"].localeCompare(b["файл"]));
  return "\uFEFF" + [H, ...rows.map(r => H.map(k => r[k] || ""))].map(r => r.map(x => f(String(x))).join(";")).join("\r\n") + "\r\n";
}

/* ================= СЛОВАРЬ (быстрая правка синонимов) ================= */
let dictDirty = false;
function renderDict(){
  const q = norm($("dq").value);
  const body = $("dbody"); body.innerHTML = "";
  DICT.forEach(r => {
    if (q && !norm(r["слово"] + " " + r["теги"] + " " + r["категория"]).includes(q)) return;
    const n = itemsOf(r["слово"]).length;
    const tr = document.createElement("tr");
    if (r._chg) tr.className = "chg";
    tr.innerHTML = `<td>${esc(rowCats(r).map(cap).join(", ") || "—")}</td>
      <td><b>${esc(cap(r["слово"]))}</b> <span class="muted">${n ? "· " + n + " карт." : "· нет картинок"}</span></td>
      <td>${esc(rowVariants(r).join(", "))}</td>
      <td class="tg" style="display:flex;gap:6px"><input type="text" value="${esc(r["теги"])}" data-k="теги" placeholder="синонимы через запятую">
        <button class="sg" data-ed="1" title="Изменить всё">✎</button></td>`;
    tr.querySelector("[data-k]").oninput = ev => {
      r["теги"] = ev.target.value.trim(); r._chg = true; tr.className = "chg";
      dictDirty = true; $("dsavewrap").hidden = false;
    };
    tr.querySelector("[data-ed]").onclick = () => openEditor(r);
    body.appendChild(tr);
  });
}
$("dq").oninput = () => { clearTimeout(renderDict.t); renderDict.t = setTimeout(renderDict, 200); };
$("dadd").onclick = () => openEditor(null);
$("dsave").onclick = async () => {
  $("dsave").disabled = true; $("dsave").textContent = "Сохраняю…";
  DICT.forEach(r => delete r._chg);
  dictDirty = false; $("dsavewrap").hidden = true;
  await saveFiles([], "Админка: синонимы");
  $("dsave").disabled = false; $("dsave").textContent = "Сохранить синонимы";
};
addEventListener("beforeunload", e => { if (dictDirty || Q.length){ e.preventDefault(); e.returnValue = ""; } });

/* ================= СБОРКА ================= */
async function loadReport(){
  const t = await readText("отчёт.json").catch(() => null);
  if (!t){ $("rep").innerHTML = '<p class="muted">Отчёта пока нет.</p>'; return; }
  const r = JSON.parse(t);
  const li = (title, arr, cls = "") => arr && arr.length ? `<h4 style="margin:14px 0 4px" class="${cls}">${title} (${arr.length})</h4>
    <ul class="rep">${arr.slice(0, 60).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  $("rep").innerHTML = `<b>Последняя сборка:</b> ${new Date(r.time).toLocaleString("ru-RU")}<br>
    <span class="muted">картинок ${r.count}, слов ${r.words}, план ${r.plan[0]} из ${r.plan[1]}</span>
    ${li("Добавлено", r.added)}${li("Заменено", r.replaced)}${li("Новые слова", r.new_words)}
    ${li("Не обработано — осталось в папке «новые»", r.left, "st err")}${li("Предупреждения", r.warn, "st warn")}`;
  const bad = (r.left || []).length;
  document.querySelector('.tab[data-t="rep"]').innerHTML = "Сборка" + (bad ? `<b>${bad}</b>` : "");
}
$("rebuild").onclick = async () => {
  try {
    await gh(repoPath("/actions/workflows/publish.yml/dispatches"), {method: "POST", body: JSON.stringify({ref: S.branch})});
    status("run", "Запущено…"); setTimeout(() => watchRuns(), 4000);
  } catch (e) { alert("Не получилось: " + e.message); }
};
