/* Управление социальными историями. Работает через ту же авторизацию GitHub, что и карточки. */
"use strict";
(() => {
  const el=id=>document.getElementById(id);
  const say=txt=>{el("story-status").textContent=txt;};
  const clean=s=>String(s||"").trim();
  const html=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const EXTS={"image/png":"png","image/jpeg":"jpg","image/webp":"webp"};
  let data={version:1,name:"Социальные истории",items:[]},ready=false,loading=false;
  async function refresh(){
    if(loading)return;
    loading=true;
    try {
      const raw=await readText("stories/catalog.json");
      data=raw?JSON.parse(raw):{version:1,name:"Социальные истории",items:[]};
      if(!Array.isArray(data.items))data.items=[];
      ready=true;render();say("");
    } catch(err){say("Не получилось загрузить истории: "+err.message);}
    finally{loading=false;}
  }
  function catalogFiles(extra=[]){
    const doc={...data,count:data.items.length,updated:new Date().toISOString().slice(0,10)};
    const json=JSON.stringify(doc,null,2)+"\n";
    return [...extra,{path:"stories/catalog.json",b64:b64FromText(json)},
      {path:"stories/catalog.js",b64:b64FromText("window.STORY_CATALOG="+JSON.stringify(doc)+";\n")}];
  }
  async function save(extra,msg){
    say("Сохраняю в GitHub…");
    await commit(catalogFiles(extra),msg);
    say("Сохранено! Сайт обновится после автоматической публикации.");
    render();
  }
  function render(){
    const q=clean(el("story-search").value).toLowerCase();
    const matches=data.items.filter(i=>(i.title+" "+(i.tags||[]).join(" ")).toLowerCase().includes(q));
    const root=el("story-items");root.innerHTML="";
    if(!matches.length){root.innerHTML='<p class="muted">Историй пока нет или по запросу ничего не найдено.</p>';return;}
    for(const item of matches){
      const block=document.createElement("div");block.className="w";
      const picture=document.createElement("img");picture.src="stories/"+item.file.split("/").map(encodeURIComponent).join("/");
      picture.alt="";picture.style.cssText="width:130px;max-height:130px;object-fit:contain;background:white;border-radius:10px";
      const info=document.createElement("div");info.style.cssText="flex:1;min-width:150px";
      info.innerHTML="<b>"+html(item.title)+"</b><div class=muted>"+html((item.tags||[]).join(", "))+"</div>";
      const top=document.createElement("div");top.style.cssText="display:flex;gap:12px;align-items:center;flex-wrap:wrap";
      top.append(picture,info);block.appendChild(top);
      const controls=document.createElement("div");controls.className="segs";
      for(const [label,fn] of [["Изменить название и теги",()=>edit(item)],["Заменить картинку",()=>replace(item)],["Удалить",()=>remove(item)]]){
        const btn=document.createElement("button");btn.className="sg";btn.textContent=label;btn.onclick=fn;controls.appendChild(btn);
      }
      const a=document.createElement("a");a.href="stories.html?id="+encodeURIComponent(item.id);a.target="_blank";a.className="sg";a.textContent="Посмотреть ↗";
      controls.appendChild(a);block.appendChild(controls);root.appendChild(block);
    }
  }
  async function getFile(file){
    if(!file || !EXTS[file.type])throw Error("Выберите PNG, JPG или WEBP.");
    if(file.size>15*1024*1024)throw Error("Файл больше 15 МБ. Пожалуйста, сохраните его меньшим без потери читаемости.");
    const bytes=new Uint8Array(await file.arrayBuffer());
    return {ext:EXTS[file.type],b64:b64FromBytes(bytes)};
  }
  el("story-add").onclick=async()=>{
    const title=clean(el("story-title").value),tags=clean(el("story-tags").value),file=el("story-image").files[0];
    if(!title||!file){say("Введите название и выберите картинку.");return;}
    const btn=el("story-add");btn.disabled=true;
    try {
      if(!ready)await refresh();if(!ready)throw Error("Каталог историй недоступен.");
      const f=await getFile(file);
      const id="story-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,7);
      const rel="images/"+id+"."+f.ext;
      data.items.push({id,title,file:rel,bytes:file.size,tags:tags.split(",").map(clean).filter(Boolean)});
      await save([{path:"stories/"+rel,b64:f.b64}],"Социальная история: добавлена "+title);
      el("story-title").value="";el("story-tags").value="";el("story-image").value="";
    }catch(e){await refresh();say("Ошибка: "+e.message);}
    finally{btn.disabled=false;}
  };
  async function edit(item){
    const name=prompt("Название истории",item.title);if(name===null)return;
    if(!clean(name)){say("Название не может быть пустым.");return;}
    const tags=prompt("Ключевые слова через запятую",(item.tags||[]).join(", "));if(tags===null)return;
    const old={...item};item.title=clean(name);item.tags=tags.split(",").map(clean).filter(Boolean);
    try{await save([],"Социальная история: изменена "+item.title);}catch(e){Object.assign(item,old);say("Ошибка: "+e.message);}
  }
  function replace(item){
    const inp=document.createElement("input");inp.type="file";inp.accept="image/png,image/jpeg,image/webp";
    inp.onchange=async()=>{
      const file=inp.files[0];if(!file)return;
      try{
        const f=await getFile(file),old=item.file,rel="images/"+item.id+"."+f.ext;
        item.file=rel;item.bytes=file.size;
        const edits=[{path:"stories/"+rel,b64:f.b64}];
        if(old!==rel)edits.push({path:"stories/"+old,del:true});
        await save(edits,"Социальная история: заменена картинка "+item.title);
      }catch(e){await refresh();say("Ошибка: "+e.message);}
    };inp.click();
  }
  async function remove(item){
    if(!confirm("Точно удалить социальную историю «"+item.title+"»?"))return;
    data.items=data.items.filter(x=>x.id!==item.id);
    try{await save([{path:"stories/"+item.file,del:true}],"Социальная история: удалена "+item.title);}
    catch(e){await refresh();say("Ошибка: "+e.message);}
  }
  el("story-search").oninput=render;
  document.querySelector('[data-t="stories"]').addEventListener("click",()=>{if(!ready)refresh();});
})();
