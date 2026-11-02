(async () => {
  "use strict";
  const statusEl = document.getElementById("map-status");
  let statusTimer;
  function status(text, error = false) {
    clearTimeout(statusTimer);
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.style.borderColor = error ? "#a33" : "#aaa";
    if (error) console.error(text);
    else statusTimer = setTimeout(() => { statusEl.hidden = true; }, 7000);
  }
  async function dependency(urls, available) {
    if (available()) return;
    let last;
    for (const url of urls) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          const timer = setTimeout(() => {
            script.remove(); reject(new Error("Timed out loading " + url));
          }, 25000);
          script.src = url;
          script.onload = () => { clearTimeout(timer); resolve(); };
          script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error("Could not load " + url)); };
          document.head.append(script);
        });
        if (!available()) throw new Error("Library did not initialise: " + url);
        return;
      } catch (error) { last = error; }
    }
    throw last;
  }
  await dependency([
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"
  ], () => !!window.L);
  const archive = window.ARCHIVE_DATA;
  if (!archive?.points?.features || !archive?.imagery) throw new Error("archive-data.js is missing or invalid.");
  const mapEl = document.getElementById("map");
  const map = L.map(mapEl, { zoomControl: false }).setView([22.329037,113.981440],11.07);
  window.archiveMap = map;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  L.control.zoom({position:"bottomleft"}).addTo(map);
  L.control.scale({position:"bottomleft",imperial:false}).addTo(map);
  map.createPane("archivePoints");
  map.getPane("archivePoints").style.zIndex = "600";
  const colours = { architecture:"#a6cee3", cemetery:"#d1d86d", "home altar":"#b2df8a", landscape:"#e3a6e1", shrine:"#e3caa6", village:"#7793ce" };
  const pointLayer = L.geoJSON(archive.points, {
    pane:"archivePoints",
    pointToLayer: (feature,latlng) => L.circleMarker(latlng, {
      pane:"archivePoints",radius:5,color:"#232323",weight:1,
      fillColor:colours[feature.properties?.photo_subject] || "#d45aab",
      fillOpacity:1
    })
  }).addTo(map);
  // Compatibility surface for the preserved interface controller.
  mapEl.project = coords => {
    const p = map.latLngToContainerPoint([coords[1],coords[0]]);
    const rect = mapEl.getBoundingClientRect();
    return [p.x+rect.left,p.y+rect.top];
  };
  mapEl.pickAt = (pixel,options={}) => {
    let best = null, distance = Math.max(options.radius || 6, 6);
    for (const feature of archive.points.features) {
      const c = feature.geometry?.coordinates;
      if (!c) continue;
      const p = map.latLngToContainerPoint([c[1],c[0]]);
      const d = Math.hypot(p.x-pixel[0],p.y-pixel[1]);
      if (d <= distance) { best=feature; distance=d; }
    }
    return best ? { layerId:"B05_sheet_3c4d874a_b942_4d3a_a0b6_94ff73568ed8",object:best } : null;
  };
  const escapeLabel = text => String(text).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  pointLayer.eachLayer(layer => {
    const text = layer.feature.properties?.place_name;
    if (text) layer.bindTooltip(escapeLabel(text),{permanent:true,direction:"top",className:"archive-point-label",opacity:.85});
  });
  const labels = () => pointLayer.eachLayer(layer => {
    const tip=layer.getTooltip();
    if(tip) { if(map.getZoom()>=18) layer.openTooltip(); else layer.closeTooltip(); }
  });
  map.on("zoomend",labels); labels();
  // All TIFFs are lazy-loaded only after a user activates them.
  let rasterDependencies;
  function rasterReady() {
    if (!rasterDependencies) rasterDependencies=(async()=>{
      await dependency(["https://unpkg.com/georaster","https://cdn.jsdelivr.net/npm/georaster"],()=>typeof window.parseGeoraster==="function");
      await dependency(["https://unpkg.com/proj4","https://cdn.jsdelivr.net/npm/proj4"],()=>typeof window.proj4==="function");
      proj4.defs("EPSG:2326", "+proj=tmerc +lat_0=22.3121333333333 +lon_0=114.178555555556 +k=1 +x_0=836694.05 +y_0=819069.8 +ellps=intl +towgs84=-162.619,-276.959,-161.764,-0.067753,2.243648,1.158828,-1.094246 +units=m +no_defs");
      await dependency(["https://unpkg.com/georaster-layer-for-leaflet/dist/georaster-layer-for-leaflet.min.js","https://cdn.jsdelivr.net/npm/georaster-layer-for-leaflet/dist/georaster-layer-for-leaflet.min.js"],()=>typeof window.GeoRasterLayer==="function");
    })().catch(error=>{rasterDependencies=null;throw error;});
    return rasterDependencies;
  }
  const rasterRecords = new Map();
  archive.imagery.forEach((entry,index)=>{
    const pane="archiveRaster"+index;
    map.createPane(pane);
    map.getPane(pane).style.zIndex=String(250+index);
    map.getPane(pane).style.pointerEvents="none";
    const rec={...entry,pane,on:false,opacity:1,layer:null,pending:null,touched:0};
    rec.getAttribute = key => key==="visible" ? String(rec.on) : key==="opacity" ? String(rec.opacity) : rec[key];
    rec.setAttribute = (key,value) => {
      if(key==="opacity") {
        rec.opacity=Number(value);
        rec.layer?.setOpacity(rec.opacity);
      }
      if(key==="visible") {
        rec.on=value==="true";
        if(rec.on) activateRaster(rec);
        else if(rec.layer && map.hasLayer(rec.layer)) map.removeLayer(rec.layer);
      }
    };
    rasterRecords.set(entry.id,rec);
  });
  let serial=Promise.resolve();
  async function activateRaster(rec) {
    rec.touched=Date.now();
    if(rec.layer) { if(rec.on && !map.hasLayer(rec.layer)) rec.layer.setOpacity(rec.opacity).addTo(map); return; }
    if(rec.pending) return rec.pending;
    rec.pending=serial.then(async()=>{
      if(!rec.on) return;
      status("Loading imagery: "+rec.label+" …");
      await rasterReady();
      const url=new URL(rec.src,document.baseURI).href;
      let raster;
      try { raster=await parseGeoraster(url); }
      catch(streamError) {
        console.warn("Retrying full TIFF download",rec.src,streamError);
        const response=await fetch(url);
        if(!response.ok) throw new Error("HTTP "+response.status+": "+url);
        raster=await parseGeoraster(await response.arrayBuffer());
      }
      if(!raster.projection) throw new Error("Missing TIFF CRS: "+rec.src+". Supply a georeferenced TIFF; no CRS will be guessed.");
      const projection=String(raster.projection);
      const code=projection.replace(/^EPSG:/i,"");
      if(/^\d+$/.test(code) && !proj4.defs("EPSG:"+code)) {
        const response=await fetch("https://epsg.io/"+code+".proj4");
        if(!response.ok) throw new Error("Cannot resolve EPSG:"+code);
        const definition=(await response.text()).trim();
        if(!definition.includes("+proj=")) throw new Error("Invalid projection definition for EPSG:"+code);
        proj4.defs("EPSG:"+code,definition);
      }
      rec.layer=new GeoRasterLayer({
        georaster:raster,proj4:window.proj4,pane:rec.pane,
        opacity:rec.opacity,resolution:128,debugLevel:0,
        keepBuffer:1,updateWhenIdle:true
      });
      const bounds=rec.layer.getBounds();
      if(!bounds?.isValid()) throw new Error("Invalid geographic bounds: "+rec.src);
      if(rec.on) rec.layer.addTo(map);
      console.info("Archive imagery ready", {file:rec.src,projection:raster.projection,bands:raster.numberOfRasters,bounds:bounds.toBBoxString()});
      status("Loaded: "+rec.label);
      // Release older hidden raster layers; active Compare layers are never capped.
      const hidden=[...rasterRecords.values()].filter(r=>r.layer&&!r.on).sort((a,b)=>b.touched-a.touched);
      hidden.slice(1).forEach(r=>{r.layer.remove();r.layer=null;});
    }).catch(error=>{
      rec.layer?.remove(); rec.layer=null;
      status("Could not display "+rec.label+"\n"+error.message+"\nUncheck and recheck to retry. See Console for details.",true);
      console.error("Raster failure",rec.src,error);
    }).finally(()=>{rec.pending=null;});
    serial=rec.pending.catch(()=>{});
    return rec.pending;
  }
  // Stop UI gestures reaching the map; do not disable scrolling inside panels.
  for(const id of ["controls","meta"]) {
    const el=document.getElementById(id);
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }
  window.addEventListener("resize",()=>map.invalidateSize());

      // Layer ids exactly as exported from QGIS2WebMap.
      const POINTS = "B05_sheet_3c4d874a_b942_4d3a_a0b6_94ff73568ed8";

      // All spatial/topographic imagery managed by the Map Layers panel.
      // Order is the fixed stacking order (bottom to top, as exported);
      // labels are display names only — source files and ids are unchanged.
      const IMAGERY = [
        { id: "T1200_190SE_D_196801_modified_22cd3a28_97da_4b43_9a88_708e829d66c5", label: "190se_d_1968/01" },
        { id: "T1200_207NE_B_196802_modified_03bddc70_106b_45e1_8e3e_c5ef396adb34", label: "207ne_b_1968/02" },
        { id: "T1200_190SE_D_197812_modified_4ceb8c13_093f_4108_86c5_91a707ad402d", label: "190se_d_1978/12" },
        { id: "T1200_207NE_B_197807_modified_32265cf2_66bb_40a3_b678_0b08c510cfad", label: "207ne_b_1978/07" },
        { id: "HP1C_09SE13A_198704_modified_6b95ddb4_348f_49ba_8944_0f3be54c6dd5", label: "09se13a_1987/04" },
        { id: "HP1C_09SE13A_199805_modified_c9110147_e67c_439f_8902_0d509720c0b7", label: "09se13a_1998/05" },
        { id: "HP1C_09SE13A_200803_modified_e43825a2_0ba4_43d2_9692_35abd8dc42e8", label: "09se13a_2008/03" },
        { id: "HP1C_09SE13C_198709_modified_8e0f284f_90e1_44c1_bbc5_c9f937528cc8", label: "09se13c_1987/09" },
        { id: "HP1C_09SE13C_199910_modified_8bce7e8d_9809_4fbd_9e06_7fa580a74597", label: "09se13c_1999/10" },
        { id: "HP1C_09SE13C_200801_modified_367a29c2_5cde_49c2_9229_2146827a1922", label: "09se13c_2008/01" },
        { id: "SE9A_2026", label: "9-SE-A_2026" },
        { id: "SE9C_2026", label: "9-SE-C_2026" }
      ];

      // Timeline: five discrete positions. Each position is a group of sheets
      // shown together (the 2026 position uses the two 9-SE sheets that
      // replaced the broken layer0 topographic file).
      const PERIODS = [
        {
          label: "1968",
          layers: [
            "T1200_190SE_D_196801_modified_22cd3a28_97da_4b43_9a88_708e829d66c5",
            "T1200_207NE_B_196802_modified_03bddc70_106b_45e1_8e3e_c5ef396adb34"
          ],
          sheets: "T1200-190SE_D-196801 / T1200-207NE_B-196802"
        },
        {
          label: "1978",
          layers: [
            "T1200_190SE_D_197812_modified_4ceb8c13_093f_4108_86c5_91a707ad402d",
            "T1200_207NE_B_197807_modified_32265cf2_66bb_40a3_b678_0b08c510cfad"
          ],
          sheets: "T1200-190SE_D-197812 / T1200-207NE_B-197807"
        },
        {
          label: "1998\u20131999",
          layers: [
            "HP1C_09SE13A_199805_modified_c9110147_e67c_439f_8902_0d509720c0b7",
            "HP1C_09SE13C_199910_modified_8bce7e8d_9809_4fbd_9e06_7fa580a74597"
          ],
          sheets: "HP1C-09SE13A-199805 / HP1C-09SE13C-199910"
        },
        {
          label: "2008",
          layers: [
            "HP1C_09SE13A_200803_modified_e43825a2_0ba4_43d2_9692_35abd8dc42e8",
            "HP1C_09SE13C_200801_modified_367a29c2_5cde_49c2_9229_2146827a1922"
          ],
          sheets: "HP1C-09SE13A-200803 / HP1C-09SE13C-200801"
        },
        {
          label: "2026",
          layers: [
            "SE9A_2026",
            "SE9C_2026"
          ],
          sheets: "9-SE-A / 9-SE-C (2026 Official Digital Topographic Map)"
        }
      ];

      // Fields rendered in the hover card and the record panel. Working
      // columns (photo no., box, file name, source, film keycode, handler,
      // sorting date, photograph path, …) are deliberately not displayed.
      const FIELDS = [
        ["photo_subject", "Type"],
        ["place_name", "Place"],
        ["photographer", "Photographer"],
        ["photographer_latitude", "Latitude"],
        ["photographer_longitude", "Longitude"],
        ["location_precision", "Precision"],
        ["location_note", "Note"]
      ];

      // Capture dates are combined into a single "Date" row: one value when
      // start and end are the same day, otherwise "start - end".
      const DATE_KEYS = ["capture_date_start", "capture_date_end"];

      const dateText = (props) => {
        const start = hasValue(props.capture_date_start) ? String(props.capture_date_start).trim() : "";
        const end = hasValue(props.capture_date_end) ? String(props.capture_date_end).trim() : "";
        if (start && end && start === end) return start;
        if (start && end) return `${start} - ${end}`;
        return start || end;
      };

      // Ordered display rows for a record: the combined date first, then the
      // remaining whitelisted fields that actually have a value.
      const displayRows = (props) => {
        const rows = [];
        const date = dateText(props);
        if (date) rows.push(["capture_date", "Date", date]);
        for (const [key, label] of FIELDS) {
          if (hasValue(props[key])) rows.push([key, label, props[key]]);
        }
        return rows;
      };

      // Hard rule for every popup surface (hover card + record panel): a data
      // column is shown only via displayRows() above. Any other column — in
      // particular raw working columns whose name contains an underscore,
      // such as "cleaning_note" — is stripped before rendering, so it can
      // never appear even if new columns are added to the data. A few
      // internal keys stay available because the interface itself needs them
      // (the photo image, the record title, the combined date).
      const INTERNAL_KEYS = ["file_name", "capture_date_start", "capture_date_end"];
      const APPROVED_KEYS = new Set(FIELDS.map(([key]) => key).concat(INTERNAL_KEYS));
      const isInternalColumn = (key) =>
        typeof key === "string" && key.includes("_") && !APPROVED_KEYS.has(key);
      const publicProps = (props) => {
        const clean = {};
        for (const [key, value] of Object.entries(props || {})) {
          if (!isInternalColumn(key)) clean[key] = value;
        }
        return clean;
      };

      const SUBJECT_COLOURS = {
        architecture: "#a6cee3",
        cemetery: "#d1d86d",
        "home altar": "#b2df8a",
        landscape: "#e3a6e1",
        shrine: "#e3caa6",
        village: "#7793ce"
      };

      const $ = (id) => document.getElementById(id);
      const layerEl = (id) => rasterRecords.get(id);

      const state = {
        // "timeline" | "compare" | null (mutually exclusive)
        mode: null,
        period: 0,
        tlOpacity: 1,
        // per-layer Compare state, independent of Timeline opacity:
        // id -> { on: boolean, opacity: 0..1 }
        compare: new Map(IMAGERY.map(({ id }) => [id, { on: false, opacity: 1 }])),
        panelOpen: false,
        selected: null
      };

      /* ---------------- layer control ---------------- */

      const setVisible = (id, on) => {
        const el = layerEl(id);
        if (!el) return;
        const want = on ? "true" : "false";
        if (el.getAttribute("visible") !== want) el.setAttribute("visible", want);
      };

      const setOpacity = (id, value) => {
        const el = layerEl(id);
        if (!el) return;
        const want = String(Math.round(value * 1000) / 1000);
        if (el.getAttribute("opacity") !== want) el.setAttribute("opacity", want);
      };

      // The single source of truth for which imagery is on screen. The open-map
      // basemap ("osm") is permanent and is never touched here; points and
      // overlays are never touched either. Stacking order is fixed by the
      // order of the om-layer elements in the markup, so it never depends on
      // the order in which layers are switched on.
      const applyLayers = () => {
        const active = new Set(state.mode === "timeline" ? PERIODS[state.period].layers : []);
        for (const { id } of IMAGERY) {
          const saved=state.compare.get(id);
          const on=state.mode === "timeline" ? active.has(id) : state.mode === "compare" && !!saved?.on;
          if(on) setOpacity(id,state.mode === "timeline" ? state.tlOpacity : saved.opacity);
          setVisible(id,!!on);
        }
      };

      /* ---------------- credits ---------------- */

      const creditSlot = () => document.querySelector(".leaflet-control-attribution");

      const measureCredit = () => {
        const slot = creditSlot();
        const h = slot ? Math.ceil(slot.getBoundingClientRect().height) : 0;
        document.documentElement.style.setProperty("--credit-h", `${h + 22}px`);
      };

      /* ---------------- Map Layers panel ---------------- */

      const panel = $("panel-layers");
      const btnLayers = $("btn-layers");

      // Opening/closing the panel never changes layers, mode state, opacity,
      // or the camera — it only shows or hides the controls themselves.
      const setPanelOpen = (open) => {
        state.panelOpen = open;
        panel.hidden = !open;
        btnLayers.setAttribute("aria-expanded", open ? "true" : "false");
      };

      btnLayers.addEventListener("click", () => setPanelOpen(!state.panelOpen));

      /* ---------------- mode switching ---------------- */

      const modeTimeline = $("mode-timeline");
      const modeCompare = $("mode-compare");
      const tlBlock = $("tl-block");
      const cmpBlock = $("cmp-block");

      // Timeline and Compare are mutually exclusive; clicking the active mode
      // unchecks it and hides all panel-managed imagery (open-map basemap and
      // points stay on). Each mode keeps its own saved settings, so switching
      // back restores exactly what that mode had before.
      const setMode = (mode) => {
        state.mode = state.mode === mode ? null : mode;
        modeTimeline.checked = state.mode === "timeline";
        modeCompare.checked = state.mode === "compare";
        tlBlock.hidden = state.mode !== "timeline";
        cmpBlock.hidden = state.mode !== "compare";
        applyLayers();
      };

      modeTimeline.addEventListener("change", () => setMode("timeline"));
      modeCompare.addEventListener("change", () => setMode("compare"));

      /* ---------------- timeline controls ---------------- */

      const periodInput = $("period");
      const periodValue = $("period-value");
      const periodSheets = $("period-sheets");
      const opacityInput = $("opacity");
      const opacityValue = $("opacity-value");

      const showPeriodLabel = () => {
        const period = PERIODS[state.period];
        periodValue.textContent = period.label;
        if (periodSheets) periodSheets.textContent = `2 sheets \u00b7 ${period.sheets}`;
      };

      showPeriodLabel();

      periodInput.addEventListener("input", () => {
        state.period = Number(periodInput.value);
        showPeriodLabel();
        // The saved timeline opacity carries across positions.
        applyLayers();
      });

      let opacityRaf = 0;
      opacityInput.addEventListener("input", () => {
        state.tlOpacity = Number(opacityInput.value) / 100;
        opacityValue.textContent = `${opacityInput.value}%`;
        if (state.mode !== "timeline") return;
        // Each attribute write makes the runtime rebuild the layer, so batch
        // the two sheets into one animation frame while the slider is dragged.
        if (opacityRaf) return;
        opacityRaf = requestAnimationFrame(() => {
          opacityRaf = 0;
          if(state.mode === "timeline") for (const id of PERIODS[state.period].layers) setOpacity(id, state.tlOpacity);
        });
      });

      /* ---------------- compare list ---------------- */

      const cmpList = $("cmp-list");

      for (const { id, label } of IMAGERY) {
        const saved = state.compare.get(id);

        const item = document.createElement("div");
        item.className = "cmp-item";

        const row = document.createElement("label");
        row.className = "cmp-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.id = id;
        box.addEventListener("change", () => {
          saved.on = box.checked;
          range.disabled = !box.checked;
          applyLayers();
        });
        const name = document.createElement("span");
        name.className = "cmp-name";
        name.textContent = label;
        row.append(box, name);

        const op = document.createElement("div");
        op.className = "cmp-op";
        const range = document.createElement("input");
        range.type = "range";
        range.min = "0";
        range.max = "100";
        range.step = "1";
        range.value = "100";
        range.disabled = true;
        range.setAttribute("aria-label", `Opacity \u2014 ${label}`);
        const pct = document.createElement("span");
        pct.className = "cmp-pct";
        pct.textContent = "100%";
        let compareRaf=0;
        range.addEventListener("input", () => {
          saved.opacity = Number(range.value) / 100;
          pct.textContent = `${range.value}%`;
          if (!saved.on) return;
          if (compareRaf) return;
          compareRaf = requestAnimationFrame(() => {
            compareRaf = 0;
            if(state.mode === "compare" && saved.on) setOpacity(id, saved.opacity);
          });
        });
        op.append(range, pct);

        item.append(row, op);
        cmpList.appendChild(item);
      }

      /* ---------------- picking ---------------- */

      const propsOf = (picked) => {
        if (!picked || picked.layerId !== POINTS) return null;
        const object = picked.object ?? {};
        // Strip internal columns (e.g. "cleaning_note") at the single point
        // where picked data enters the interface, so the hover card and the
        // record panel can only ever see whitelisted, displayable fields.
        const props = publicProps(object.properties ?? object);
        if (!props || !props.file_name) return null;
        return props;
      };

      const pickAt = (clientX, clientY, radius) => {
        const rect = mapEl.getBoundingClientRect();
        if (typeof mapEl.pickAt !== "function") return null;
        let hit = null;
        try {
          hit = mapEl.pickAt([clientX - rect.left, clientY - rect.top], { radius });
        } catch (error) {
          return null;
        }
        return propsOf(hit);
      };

      const overWidget = (event) =>
        event.composedPath().some((node) => node && node.tagName === "OM-WIDGET");

      const escapeHtml = (value) =>
        String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

      const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== "";

      /* ---------------- hover card ---------------- */

      const hovercard = $("hovercard");
      let hoverRaf = 0;
      let hoverPoint = null;

      const hideHover = () => {
        hovercard.hidden = true;
        hoverPoint = null;
      };

      const showHover = (props, x, y) => {
        const rows = displayRows(props)
          .map(
            ([, label, value]) =>
              `<div class="hc-row"><span class="hc-label">${escapeHtml(label)}</span><span class="hc-value">${escapeHtml(value)}</span></div>`
          )
          .join("");
        hovercard.innerHTML = `<h3>${escapeHtml(props.place_name || "Record")}</h3>${rows}<p class="hc-foot">Click for the full record</p>`;
        hovercard.hidden = false;

        const gap = 16;
        const box = hovercard.getBoundingClientRect();
        let left = x + gap;
        let top = y - box.height / 2;
        if (left + box.width > window.innerWidth - 12) left = x - box.width - gap;
        top = Math.max(12, Math.min(top, window.innerHeight - box.height - 12));
        hovercard.style.left = `${Math.max(12, left)}px`;
        hovercard.style.top = `${top}px`;
      };

      mapEl.addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch") return;
        if (overWidget(event)) {
          hideHover();
          return;
        }
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          const props = pickAt(event.clientX, event.clientY, 6);
          if (props) showHover(props, event.clientX, event.clientY);
          else hideHover();
        });
      });

      mapEl.addEventListener("pointerleave", hideHover);
      map.on("movestart",hideHover);

      /* ---------------- metadata panel ---------------- */

      const meta = $("meta");
      const metaBody = $("meta-body");
      const metaTitle = $("meta-title");
      const metaEyebrow = $("meta-eyebrow");
      const marker = $("marker");
      let markerRaf = 0;
      let markerLngLat = null;

      const syncMarker = () => {
        if (!markerLngLat || meta.hidden || typeof mapEl.project !== "function") {
          markerRaf = 0;
          return;
        }
        const point = mapEl.project(markerLngLat);
        if (point && Number.isFinite(point[0])) {
          marker.style.left = `${point[0]}px`;
          marker.style.top = `${point[1]}px`;
          marker.hidden = false;
        }
        markerRaf = requestAnimationFrame(syncMarker);
      };

      const startMarker = (lngLat) => {
        markerLngLat = lngLat;
        marker.hidden = false;
        if (!markerRaf) markerRaf = requestAnimationFrame(syncMarker);
      };

      const closeMeta = () => {
        meta.hidden = true;
        marker.hidden = true;
        markerLngLat = null;
        state.selected = null;
        document.body.classList.remove("meta-open");
      };

      const openMeta = (rawProps, lngLat) => {
        const props = publicProps(rawProps);
        const colour = SUBJECT_COLOURS[props.photo_subject] || "#888888";
        const rows = displayRows(props)
          .map(([, label, value]) => {
            const cls = label === "Latitude" || label === "Longitude" ? "num" : "";
            return `<div class="row"><dt>${escapeHtml(label)}</dt><dd class="${cls}">${escapeHtml(value)}</dd></div>`;
          })
          .join("");

        const photo = hasValue(props.file_name)
          ? `<figure><img src="photos/${encodeURIComponent(props.file_name)}.jpg" alt="${escapeHtml(props.place_name || props.file_name)}" loading="lazy" /><figcaption>${escapeHtml(props.place_name || "Field photograph")}</figcaption></figure>`
          : "";

        metaTitle.textContent = props.place_name || "Record";
        // Photo no., box and other working identifiers are intentionally not
        // shown anywhere in the record panel.
        metaEyebrow.hidden = true;
        metaBody.innerHTML = `${photo}
          <p class="subject"><span class="swatch" style="background:${colour}"></span>${escapeHtml(props.photo_subject || "unclassified")}</p>
          <dl>${rows}</dl>`;

        const img = metaBody.querySelector("img");
        if (img) {
          img.addEventListener("error", () => {
            const note=document.createElement("p");
            note.textContent="Photograph unavailable. Check the photos folder and filename case.";
            img.replaceWith(note);
            console.warn("Photo failed:",img.src);
          });
        }

        meta.hidden = false;
        document.body.classList.add("meta-open");
        state.selected = props.file_name;
        metaBody.scrollTop = 0;

        if (lngLat) startMarker(lngLat);
        else marker.hidden = true;
      };

      $("meta-close").addEventListener("click", closeMeta);

      mapEl.addEventListener("click", (event) => {
        if (overWidget(event)) return;
        const props = pickAt(event.clientX, event.clientY, 10);
        if (!props) return;
        const lngLat = [props.photographer_longitude, props.photographer_latitude].map(Number);
        openMeta(props, lngLat.every(Number.isFinite) ? lngLat : null);
        hideHover();
      });

      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (state.panelOpen) setPanelOpen(false);
        else closeMeta();
      });

      /* ---------------- initial state ---------------- */

      // Open-map basemap and points are on from the markup; every
      // panel-managed imagery layer starts hidden and neither mode is active.
      applyLayers();
      measureCredit();

      const slot = creditSlot();
      if (slot) new ResizeObserver(measureCredit).observe(slot);
      window.addEventListener("resize", measureCredit);
      map.whenReady(measureCredit);
    
  // A diagnostic helper: call archiveFitPoints() in Console to locate all records.
  window.archiveFitPoints=()=>map.fitBounds(pointLayer.getBounds(),{padding:[40,40],maxZoom:18});
})().catch(error=>{
  console.error("Archive startup failed",error);
  const el=document.getElementById("map-status");
  if(el){el.hidden=false;el.textContent="Map startup failed: "+error.message+". Check network access and the browser Console.";}
});
