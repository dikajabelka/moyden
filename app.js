/* Витрина «Картинки Мой день».
   Одна карточка = одно слово. Внутри — варианты: девочка / мальчик / без людей / фото / 2, 3… */
"use strict";
const $ = id => document.getElementById(id);
const norm = s => (s || "").toLowerCase().replace(/ё/g, "е");
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const STEP = 120;
const KEY = "mojden.sheet", FKEY = "mojden.filters";

const WHO = [["", "Все"], ["девочка", "👧 Девочка"], ["мальчик", "👦 Мальчик"], ["без людей", "Без людей"]];
const STYLE = [["", "Рисунки и фото"], ["рисунок", "Рисунки"], ["фото", "Фото"]];

let GROUPS = [], ITEM = {}, cat = "", q = "", who = "", style = "", list = [], shown = 0;
let picked = [];
try { picked = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) {}
try { ({who = "", style = ""} = JSON.parse(localStorage.getItem(FKEY)) || {}); } catch (e) {}

(window.CATALOG ? Promise.resolve(window.CATALOG) : fetch("catalog.json").then(r => r.json()))
  .then(init)
  .catch(() => { $("count").textContent = "Не удалось загрузить каталог. Запустите «Собрать.bat» и обновите страницу."; });

function variantLabel(i){
  const p = [];
  if (i.variant) p.push(i.variant);
  if (i.style === "фото") p.push("фото");
  if (i.n > 1) p.push(i.n);
  return p.join(" ") || "основной";
}

function init(d){
  const map = new Map();
  (d.items || []).forEach(i => {
    i.variant = i.variant || ""; i.style = i.style || "рисунок"; i.n = i.n || 1;
    ITEM[i.id] = i;
    const key = i.category + "|" + (i.word || i.title.toLowerCase());
    if (!map.has(key)) map.set(key, {title: i.title, category: i.category, tags: i.tags || [], items: []});
    map.get(key).items.push(i);
  });
  GROUPS = [...map.values()].map(g => {
    const order = {"девочка":0, "мальчик":1, "без людей":2, "":3};
    g.items.sort((a, b) => (a.style === "фото") - (b.style === "фото") || order[a.variant] - order[b.variant] || a.n - b.n);
    g._t = norm(g.title); g._g = g.tags.map(norm); g._c = norm(g.category);
    g.people = g.items.some(i => i.variant === "девочка" || i.variant === "мальчик");
    return g;
  }).sort((a, b) => a._t.localeCompare(b._t, "ru"));
  picked = picked.filter(id => ITEM[id]);
  save();

  const upd = d.updated ? new Date(d.updated + "T00:00:00").toLocaleDateString("ru-RU",
    {day:"numeric", month:"long", year:"numeric"}) : "";
  const n = d.items.length;
  $("stat").innerHTML = `<span>🖼 ${n} ${plural(n,"картинка","картинки","картинок")}</span>`
    + `<span>${GROUPS.length} ${plural(GROUPS.length,"слово","слова","слов")}</span>`
    + (upd ? `<span>обновлено ${upd}</span>` : "");

  readHash();
  buildFilters(d.items.some(i => i.style === "фото"));
  buildCats(d.categories || []);
  render();
}

function plural(n, a, b, c){
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
}

/* ---------- фильтры ---------- */
function buildFilters(hasPhoto){
  const box = $("filt");
  const mk = (arr, get, set, cls) => arr.forEach(([v, label]) => {
    const b = document.createElement("button");
    b.className = "fb " + cls; b.dataset.v = v; b.textContent = label;
    b.onclick = () => { set(v); render(); writeHash(); };
    box.appendChild(b);
  });
  mk(WHO, () => who, v => who = v, "who");
  if (hasPhoto){
    const s = document.createElement("span"); s.className = "sep"; box.appendChild(s);
    mk(STYLE, () => style, v => style = v, "st");
  } else style = "";
}

function buildCats(cats){
  const box = $("cats"), counts = {};
  GROUPS.forEach(g => counts[g.category] = (counts[g.category] || 0) + 1);
  const mk = (id, name, n) => {
    const b = document.createElement("button");
    b.className = "cat"; b.dataset.c = id; b.setAttribute("role", "tab");
    b.innerHTML = esc(name) + `<small>${n}</small>`;
    b.onclick = () => { cat = id; render(); writeHash(); };
    box.appendChild(b);
  };
  mk("", "Все", GROUPS.length);
  cats.forEach(c => mk(c, c, counts[c] || 0));
}

/* Какие варианты слова показывать при текущих фильтрах.
   «Девочка»: картинки с девочкой + картинки без людей у слов, где людей не бывает (магазин). */
function visible(g){
  let c = style ? g.items.filter(i => i.style === style) : g.items;
  if (!who) return c;
  if (who === "без людей") return c.filter(i => i.variant === "без людей");
  const exact = c.filter(i => i.variant === who);
  if (exact.length) return exact;
  return g.people ? [] : c;
}

/* ---------- поиск ---------- */
let timer;
$("q").addEventListener("input", e => {
  clearTimeout(timer);
  timer = setTimeout(() => { q = e.target.value; render(); writeHash(); }, 120);
});

function score(g, words){
  let s = 0;
  for (const w of words){
    if (g._t.startsWith(w)) s += 0;
    else if (g._t.includes(" " + w)) s += 1;
    else if (g._g.includes(w)) s += 2;
    else if (g._g.some(t => t.startsWith(w))) s += 3;
    else if (g._t.includes(w)) s += 4;
    else if (g._g.some(t => t.includes(w))) s += 5;
    else if (g._c.startsWith(w)) s += 6;
    else return -1;
  }
  return s;
}

function render(){
  document.querySelectorAll(".cat").forEach(b => {
    const on = b.dataset.c === cat; b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
  });
  document.querySelectorAll(".fb.who").forEach(b => b.classList.toggle("on", b.dataset.v === who));
  document.querySelectorAll(".fb.st").forEach(b => b.classList.toggle("on", b.dataset.v === style));
  try { localStorage.setItem(FKEY, JSON.stringify({who, style})); } catch (e) {}

  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  let pool = [];
  for (const g of GROUPS){
    if (cat && g.category !== cat) continue;
    const v = visible(g);
    if (!v.length) continue;
    const s = words.length ? score(g, words) : 0;
    if (s < 0) continue;
    pool.push({g, v, s});
  }
  if (words.length) pool.sort((a, b) => a.s - b.s || a.g._t.localeCompare(b.g._t, "ru"));
  list = pool;

  const filtered = words.length || cat || who || style;
  $("count").textContent = list.length
    ? (filtered ? `Найдено слов: ${list.length}` : `Все слова: ${list.length}`) : "";
  $("empty").hidden = list.length > 0;
  if (!list.length) $("empty").innerHTML = words.length
    ? `По запросу <b>«${esc(q.trim())}»</b> ничего не нашлось${who || style ? " с выбранными фильтрами" : ""}.<br>
       Попробуйте другое слово или <a href="https://t.me/dikaja_belka">попросите автора</a> нарисовать такую картинку.`
    : "Здесь пока пусто — попробуйте другие фильтры.";
  $("grid").innerHTML = "";
  shown = 0;
  more();
}

function more(){
  const frag = document.createDocumentFragment();
  const end = Math.min(shown + STEP, list.length);
  for (let n = shown; n < end; n++) frag.appendChild(card(list[n]));
  shown = end;
  $("grid").appendChild(frag);
}
new IntersectionObserver(e => { if (e[0].isIntersecting && shown < list.length) more(); },
  {rootMargin: "600px"}).observe($("more"));

const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';

function card({g, v}){
  const cover = v[0];
  const d = document.createElement("div");
  const on = g.items.some(i => picked.includes(i.id));
  d.className = "card" + (on ? " sel" : "");
  d.dataset.ids = g.items.map(i => i.id).join(" ");
  d.tabIndex = 0;
  d.innerHTML = `<img src="${esc(cover.file)}" alt="${esc(g.title)}" loading="lazy" decoding="async">
    <div class="t">${esc(g.title)}</div>
    <div class="c">${esc(g.category || "без категории")}</div>
    ${g.items.length > 1 ? `<span class="nv" title="Вариантов картинки">${g.items.length}</span>` : ""}
    <button class="pick" title="В лист для печати" aria-label="В лист для печати">${on ? TICK : PLUS}</button>`;
  d.onclick = e => {
    if (e.target.closest(".pick")){
      const p = g.items.find(i => picked.includes(i.id));
      toggle(p ? p.id : cover.id);
    } else openGroup(g, cover);
  };
  d.onkeydown = e => { if (e.key === "Enter") openGroup(g, cover); };
  return d;
}

/* ---------- лист для печати ---------- */
function save(){
  try { localStorage.setItem(KEY, JSON.stringify(picked)); } catch (e) {}
  $("bn").textContent = picked.length;
  $("bar").classList.toggle("show", picked.length > 0);
}
function toggle(id){
  const k = picked.indexOf(id);
  if (k >= 0) picked.splice(k, 1); else picked.push(id);
  save();
  document.querySelectorAll(".card").forEach(el => {
    if (!el.dataset.ids.split(" ").includes(id)) return;
    const on = el.dataset.ids.split(" ").some(x => picked.includes(x));
    el.classList.toggle("sel", on);
    el.querySelector(".pick").innerHTML = on ? TICK : PLUS;
  });
  if (cur) showItem(cur);
}
$("bclear").onclick = () => {
  picked = []; save();
  document.querySelectorAll(".card.sel").forEach(el => {
    el.classList.remove("sel"); el.querySelector(".pick").innerHTML = PLUS;
  });
};

/* ---------- окно слова ---------- */
let cur = null, curG = null;
function openGroup(g, item){
  curG = g;
  $("dtitle").textContent = g.title;
  $("dtags").innerHTML = g.tags.map(t => `<span>${esc(t)}</span>`).join("");
  $("dtags").querySelectorAll("span").forEach(s => s.onclick = () => {
    $("q").value = q = s.textContent; cat = ""; $("dlg").close(); render(); writeHash();
  });
  $("dvars").innerHTML = g.items.length < 2 ? "" : g.items.map(i =>
    `<button data-id="${esc(i.id)}"><img src="${esc(i.file)}" alt=""><span>${esc(variantLabel(i))}</span></button>`).join("");
  $("dvars").querySelectorAll("button").forEach(b => b.onclick = () => showItem(ITEM[b.dataset.id]));
  showItem(item);
  $("dlg").showModal();
}
function showItem(i){
  cur = i;
  $("dimg").src = i.file; $("dimg").alt = i.title;
  const ext = (i.file.split(".").pop() || "").toUpperCase();
  $("dsub").textContent = [i.category, curG.items.length > 1 ? variantLabel(i) : (i.variant || ""),
    ext, i.w ? `${i.w}×${i.h}` : "", Math.max(1, Math.round(i.bytes / 1024)) + " КБ"]
    .filter(Boolean).join(" · ");
  $("dvars").querySelectorAll("button").forEach(b => {
    b.classList.toggle("on", b.dataset.id === i.id);
    b.classList.toggle("in", picked.includes(b.dataset.id));
  });
  const a = $("ddl");
  a.href = i.file;
  a.textContent = "Скачать " + ext;
  a.setAttribute("download", fileName(i, ext.toLowerCase()));
  $("dpng").hidden = ext === "PNG";          // PNG и так PNG — вторая кнопка не нужна
  $("dpick").textContent = picked.includes(i.id) ? "✓ Этот вариант в листе — убрать" : "Добавить в лист для печати";
  $("dnote").hidden = true;
}
function fileName(i, ext){
  const v = variantLabel(i);
  return i.title + (v !== "основной" && curG.items.length > 1 ? " (" + v + ")" : "") + "." + ext;
}
$("dpick").onclick = () => toggle(cur.id);
$("dx").onclick = () => $("dlg").close();
$("dlg").addEventListener("click", e => { if (e.target === $("dlg")) $("dlg").close(); });
$("dlg").addEventListener("close", () => { cur = null; });

/* PNG — для Word и программ, которые не открывают WebP. Переводит сам браузер. */
$("dpng").onclick = () => {
  const i = cur, img = new Image();
  img.onload = () => {
    const w = i.w || 512, h = i.h || Math.round(512 * img.naturalHeight / img.naturalWidth) || 512;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    try {
      c.toBlob(b => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b); a.download = fileName(i, "png");
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, "image/png");
    } catch (e) {
      $("dnote").hidden = false;
      $("dnote").textContent = "PNG можно скачать на опубликованном сайте. При открытии из папки браузер это запрещает.";
    }
  };
  img.src = i.file;
};

/* ---------- адрес страницы хранит поиск и фильтры ---------- */
function writeHash(){
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim());
  if (cat) p.set("c", cat);
  const h = p.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
}
function readHash(){
  const p = new URLSearchParams(location.hash.slice(1));
  q = p.get("q") || ""; cat = p.get("c") || "";
  if (cat && !GROUPS.some(g => g.category === cat)) cat = "";
  $("q").value = q;
}
