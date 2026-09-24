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
let DICT = [], DIDX = new Map(), CAT = {items: [], categories: []}, CATS = [];

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
  const [dict, cat] = await Promise.all([readText("словарь.csv"), readText("catalog.json")]);
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
  CATS = [...new Set([...DICT.map(r => r["категория"].toLowerCase()), ...(CAT.categories || [])].filter(Boolean))].sort();
  let dl = $("words");
  if (!dl){ dl = document.createElement("datalist"); dl.id = "words"; document.body.appendChild(dl); }
  dl.innerHTML = DICT.map(r => `<option value="${esc(r["слово"])}">`).join("");
}
const rowVariants = r => {
  const v = (r["варианты"] || "").split(",").map(norm);
  const out = VARIANTS.filter(x => v.includes(norm(x)));
  return out.length ? out : ["девочка", "мальчик"];
};
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
      variant: p.variant, style: p.style,
      n: p.n, mode: preset && preset.mode || "", newCat: "", newTags: "", newVariants: ""};
    if (row && !it.variant && onlyNoPeople(row)) it.variant = "без людей";
    Q.push(it);
  }
  renderQueue();
  if (files.length) showTab("add");
}

/* проверка одной строки очереди */
function check(it, idx){
  const r = {ok: false, msg: "", cls: "err", conflict: null, isNew: false};
  if (!it.word.trim()){ r.msg = "Впишите слово — какая это картинка."; return r; }
  const row = DIDX.get(norm(it.word));
  r.isNew = !row;
  if (r.isNew && !it.newCat.trim()){ r.msg = "Нового слова нет в словаре — выберите категорию ниже."; r.cls = "warn"; return r; }
  const needPeople = row ? !onlyNoPeople(row) : (it.newVariants || "девочка, мальчик") !== "без людей";
  if (!it.variant && !needPeople) it.variant = "без людей";
  if (!it.variant && needPeople){ r.msg = "Выберите, кто на картинке."; r.cls = "warn"; return r; }
  // занят ли такой вариант (в каталоге или в этой же очереди выше)
  const same = x => norm(x.word) === norm(it.word) && (x.variant || "") === (it.variant || "") && x.style === it.style;
  const taken = new Set(itemsOf(it.word).filter(same).map(x => x.n));
  Q.slice(0, idx).filter(same).forEach(x => taken.add(x.finalN));
  let n = it.n;
  if (taken.has(n)){
    r.conflict = true;
    if (it.mode === "replace") n = it.n;
    else { n = 1; while (taken.has(n)) n++; }
  }
  it.finalN = n;
  const cat = row ? row["категория"] : it.newCat;
  const label = [it.variant, it.style === "фото" ? "фото" : "", n > 1 ? "№" + n : ""].filter(Boolean).join(", ");
  r.ok = true; r.cls = "good";
  r.msg = `✓ «${cap(it.word.trim())}» → ${cat}${label ? ", " + label : ""}` +
    (r.conflict ? (it.mode === "replace" ? " — заменит существующую" : " — будет ещё одним вариантом") : "") +
    (r.isNew ? " · новое слово" : "");
  return r;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function renderQueue(){
  const box = $("queue");
  box.innerHTML = "";
  let allOk = Q.length > 0;
  Q.forEach((it, idx) => {
    const c = check(it, idx);
    allOk = allOk && c.ok;
    const d = document.createElement("div");
    d.className = "q " + (c.ok ? "ok" : "bad");
    const row = DIDX.get(norm(it.word));
    const vopts = [["девочка", "👧 Девочка"], ["мальчик", "👦 Мальчик"], ["без людей", "Без людей"]];
    d.innerHTML = `<img src="${it.url}" alt="">
      <div>
        <input type="text" list="words" value="${esc(it.word)}" placeholder="Слово: чистить зубы" data-k="word">
        <div class="segs">${vopts.map(([v, l]) => `<button class="sg ${it.variant === v ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}
          <button class="sg ${it.style === "фото" ? "on" : ""}" data-s="1">📷 Фото</button></div>
        ${c.conflict ? `<div class="conf"><button class="sg ${it.mode !== "replace" ? "on" : ""}" data-m="add">Ещё вариант</button>
          <button class="sg ${it.mode === "replace" ? "on" : ""}" data-m="replace">Заменить существующую</button></div>` : ""}
        ${c.isNew && it.word.trim() ? `<div class="newword"><b>Новое слово.</b> Оно добавится в словарь.
          <div class="row2"><div><label class="f">Категория</label>
            <input type="text" list="cats" value="${esc(it.newCat)}" placeholder="например: игры" data-k="newCat"></div>
          <div><label class="f">Какие картинки нужны</label><select data-k="newVariants">
            ${["девочка, мальчик", "без людей", "девочка, мальчик, без людей"].map(v =>
              `<option ${(it.newVariants || "девочка, мальчик") === v ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
          <label class="f">Теги для поиска (через запятую)</label>
          <input type="text" value="${esc(it.newTags)}" placeholder="синонимы: прыгать, батут" data-k="newTags"></div>` : ""}
        <div class="st ${c.cls}">${esc(c.msg)}</div>
      </div>
      <button class="rm" title="Убрать">✕</button>`;
    d.querySelectorAll("input[data-k],select[data-k]").forEach(inp => {
      inp.oninput = inp.onchange = () => {
        it[inp.dataset.k] = inp.value;
        if (inp.dataset.k === "word"){
          it.n = 1; it.mode = "";
          const r2 = DIDX.get(norm(inp.value));
          if (r2 && onlyNoPeople(r2) && !it.variant) it.variant = "без людей";
        }
        clearTimeout(it.t);
        it.t = setTimeout(() => { const pos = inp.selectionStart, k = inp.dataset.k; renderQueue();
          const again = $("queue").children[idx]?.querySelector(`[data-k="${k}"]`);
          if (again){ again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} } }, inp.tagName === "SELECT" ? 0 : 350);
      };
    });
    d.querySelectorAll("[data-v]").forEach(b => b.onclick = () => { it.variant = it.variant === b.dataset.v ? "" : b.dataset.v; renderQueue(); });
    d.querySelector("[data-s]").onclick = () => { it.style = it.style === "фото" ? "рисунок" : "фото"; renderQueue(); };
    d.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { it.mode = b.dataset.m; renderQueue(); });
    d.querySelector(".rm").onclick = () => { URL.revokeObjectURL(it.url); Q.splice(idx, 1); renderQueue(); };
    box.appendChild(d);
  });
  let dl = $("cats");
  if (!dl){ dl = document.createElement("datalist"); dl.id = "cats"; document.body.appendChild(dl); }
  dl.innerHTML = CATS.map(c => `<option value="${esc(c)}">`).join("");
  $("gowrap").hidden = !Q.length;
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
      const w = it.word.trim().toLowerCase().normalize("NFC");
      if (!DIDX.get(norm(w))){
        DICT.push({"категория": it.newCat.trim().toLowerCase(), "слово": w,
          "варианты": it.newVariants || "девочка, мальчик", "теги": it.newTags.trim(), "комментарий": "добавлено из админки"});
        reindex(); dictChanged = true;
      }
      const {bytes, ext} = await shrink(it);
      const name = [w, it.variant, it.style === "фото" ? "фото" : "", it.finalN > 1 ? it.finalN : ""].filter(Boolean).join(" ");
      files.push({path: `новые/${name}.${ext}`, b64: b64FromBytes(bytes)});
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
    if (q && !norm(r["слово"]).includes(q) && !norm(r["теги"]).includes(q)) continue;
    if (libFilter === "miss" && !miss.length) continue;
    if (libFilter === "empty" && its.length) continue;
    if (libFilter === "done" && miss.length) continue;
    const c = r["категория"] || "разное";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push({r, its, miss});
  }
  $("libsum").innerHTML = `<b>Нарисовано ${done} из ${need}</b> нужных вариантов · картинок на сайте: ${CAT.items.length}`;
  $("libprog").style.width = (need ? Math.round(100 * done / need) : 0) + "%";
  $("libf").innerHTML = [["", "Все слова"], ["miss", "Чего-то не хватает"], ["empty", "Совсем нет картинок"], ["done", "Готовые"]]
    .map(([v, l]) => `<button class="sg ${libFilter === v ? "on" : ""}" data-f="${v}">${l}</button>`).join("");
  $("libf").querySelectorAll("[data-f]").forEach(b => b.onclick = () => { libFilter = b.dataset.f; renderLib(); });

  const box = $("lib"); box.innerHTML = "";
  for (const [c, list] of byCat){
    const h = document.createElement("h3"); h.className = "lib-cat"; h.textContent = cap(c); box.appendChild(h);
    for (const {r, its, miss} of list){
      const d = document.createElement("div"); d.className = "w";
      d.innerHTML = `<div class="h"><b>${esc(cap(r["слово"]))}</b><span class="muted">${esc(r["теги"])}</span></div>
        <div class="thumbs">
          ${its.map(i => `<div class="th" data-id="${esc(i.id)}"><img src="${esc(i.file)}" loading="lazy" alt="">${esc(vlabel(i))}</div>`).join("")}
          ${miss.map(v => `<div class="miss" data-v="${esc(v)}"><i>+</i>${esc(v)}</div>`).join("")}
          <div class="miss more-add" data-v=""><i>+</i>ещё</div>
        </div>`;
      d.querySelectorAll(".th").forEach(t => t.onclick = () => itemMenu(CAT.items.find(i => i.id === t.dataset.id), r));
      d.querySelectorAll(".miss").forEach(m => m.onclick = () => pickFor(r, m.dataset.v));
      box.appendChild(d);
    }
  }
  if (!byCat.size) box.innerHTML = '<p class="muted">Ничего не найдено.</p>';
}
$("libq").oninput = () => { clearTimeout(renderLib.t); renderLib.t = setTimeout(renderLib, 200); };
const vlabel = i => [i.variant, i.style === "фото" ? "фото" : "", i.n > 1 ? i.n : ""].filter(Boolean).join(" ") || "основная";

/* выбрать файл сразу под нужное слово и вариант */
function pickFor(r, variant, mode, item){
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg";
  inp.multiple = !item;
  inp.onchange = () => {
    const files = [...inp.files];
    files.forEach((f, k) => addFiles([f], {word: r["слово"], variant: variant || (onlyNoPeople(r) ? "без людей" : ""),
      style: item ? item.style : "рисунок", n: item ? item.n : 1, mode: mode || ""}));
  };
  inp.click();
}

function itemMenu(i, r){
  const m = document.createElement("div"); m.className = "menu";
  m.innerHTML = `<div><img src="${esc(i.file)}" alt=""><h3>${esc(i.title)} · ${esc(vlabel(i))}</h3>
    <p class="muted" style="text-align:center;margin-top:-6px">${esc(i.file)} · ${Math.max(1, Math.round(i.bytes / 1024))} КБ</p>
    <button class="btn" data-a="rep">Заменить картинку (адрес останется)</button>
    <a class="btn ghost" href="${esc(i.file)}" target="_blank">Открыть</a>
    <button class="btn ghost" data-a="del" style="color:#C0392B">Удалить</button>
    <button class="btn ghost" data-a="x">Отмена</button></div>`;
  m.onclick = async e => {
    const a = e.target.dataset.a;
    if (e.target === m || a === "x") m.remove();
    if (a === "rep"){ m.remove(); pickFor(r, i.variant, "replace", i); }
    if (a === "del"){
      if (!confirm(`Удалить «${i.title} · ${vlabel(i)}»?\n\nЕсли картинку уже скачали в приложение — у них она останется, но новые пользователи её не найдут.`)) return;
      m.remove();
      try { const sha = await commit([{path: i.file, del: true}], `Админка: удалена ${i.file}`); watchRuns(sha); }
      catch (err) { alert("Не получилось: " + err.message); }
    }
  };
  document.body.appendChild(m);
}

/* ================= СЛОВАРЬ ================= */
let dictDirty = false;
function renderDict(){
  const q = norm($("dq").value);
  const body = $("dbody"); body.innerHTML = "";
  const VOPTS = ["девочка, мальчик", "без людей", "девочка, мальчик, без людей"];
  DICT.forEach((r, k) => {
    if (q && !norm(r["слово"] + " " + r["теги"] + " " + r["категория"]).includes(q)) return;
    const has = itemsOf(r["слово"]).length > 0;
    const v = rowVariants(r).join(", ");
    const tr = document.createElement("tr");
    if (r._new) tr.className = "nw"; else if (r._chg) tr.className = "chg";
    tr.innerHTML = `<td><input type="text" list="cats" value="${esc(r["категория"])}" data-k="категория" ${has ? "disabled title='У слова есть картинки — категорию не меняем, иначе сменятся адреса'" : ""}></td>
      <td><input type="text" value="${esc(r["слово"])}" data-k="слово" ${has ? "disabled title='У слова есть картинки — переименовать нельзя'" : ""}></td>
      <td><select data-k="варианты">${VOPTS.map(o => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select></td>
      <td class="tg"><input type="text" value="${esc(r["теги"])}" data-k="теги" placeholder="синонимы через запятую"></td>`;
    tr.querySelectorAll("[data-k]").forEach(inp => inp.oninput = inp.onchange = () => {
      r[inp.dataset.k] = inp.value.trim(); r._chg = true; tr.className = r._new ? "nw" : "chg";
      dictDirty = true; $("dsavewrap").hidden = false;
    });
    body.appendChild(tr);
  });
}
$("dq").oninput = () => { clearTimeout(renderDict.t); renderDict.t = setTimeout(renderDict, 200); };
$("dadd").onclick = () => {
  DICT.unshift({"категория": "", "слово": "", "варианты": "девочка, мальчик", "теги": "", "комментарий": "", _new: true});
  $("dq").value = ""; renderDict(); dictDirty = true; $("dsavewrap").hidden = false;
  $("dbody").querySelector("input[data-k='категория']").focus();
};
$("dsave").onclick = async () => {
  const bad = DICT.find(r => (r._new || r._chg) && (!r["слово"] || !r["категория"]));
  if (bad){ alert("У нового слова должны быть заполнены категория и слово."); return; }
  const seen = new Set();
  for (const r of DICT){ const k = norm(r["слово"]); if (seen.has(k)){ alert(`Слово «${r["слово"]}» записано дважды.`); return; } seen.add(k); }
  $("dsave").disabled = true; $("dsave").textContent = "Сохраняю…";
  try {
    DICT.forEach(r => { r["категория"] = r["категория"].toLowerCase(); r["слово"] = r["слово"].toLowerCase(); });
    const sha = await commit([{path: "словарь.csv", b64: b64FromText(toCSV(DICT))}], "Админка: словарь");
    DICT.forEach(r => { delete r._new; delete r._chg; });
    dictDirty = false; $("dsavewrap").hidden = true; reindex(); renderDict(); renderLib();
    watchRuns(sha);
  } catch (e) { alert("Не получилось сохранить: " + e.message); }
  $("dsave").disabled = false; $("dsave").textContent = "Сохранить словарь";
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
