(()=>{
const ESRI='https://server.arcgisonline.com/ArcGIS/rest/services/';
const arcTile=(svc)=>ESRI+svc+'/MapServer/tile/12/1582/654';
const GROUPS=[
 {name:'Street & vector',items:[
  {id:'street',name:'Street map',desc:'OpenStreetMap streets',icon:'map',img:'https://a.tile.openstreetmap.fr/osmfr/12/654/1582.png'},
  {id:'openmaptiles',name:'OpenMapTiles vector',desc:'OpenFreeMap Liberty style',icon:'layers',previewStyle:'https://tiles.openfreemap.org/styles/liberty'},
  {id:'openTopoVector',name:'OpenFreeMap Bright',desc:'Vector, crisp labels at any zoom',icon:'layers',previewStyle:'https://tiles.openfreemap.org/styles/bright'},
  {id:'hot',name:'OSM Humanitarian',desc:'OSM France, HOT style',icon:'volunteer_activism',img:'https://a.tile.openstreetmap.fr/hot/12/654/1582.png'}
 ]},
 {name:'Aerial & imagery',items:[
  {id:'eoxS2',name:'Sentinel-2 cloudless',desc:'EOX 2020 mosaic, 10 m, CC BY-NC-SA 4.0',icon:'satellite',img:'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/12/1582/654.jpg'},
  {id:'aerial',name:'High-res aerial (U.S.)',desc:'USGS / USDA NAIP, U.S. only',icon:'satellite',img:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/12/1582/654'},
  {id:'naip',name:'USDA NAIP aerial',desc:'Current U.S. aerial imagery',icon:'layers',img:'https://apps.geo.fpac.usda.gov/geo-imagery/rest/services/naip/conus_naip/ImageServer/exportImage?bbox=-122.52%2C37.70%2C-122.32%2C37.83&bboxSR=4326&size=160%2C100&imageSR=4326&format=jpgpng&f=image'},
  {id:'imagery',name:'World imagery (Esri)',desc:'Sharper close-up varies by location',icon:'satellite_alt',img:arcTile('World_Imagery')},
  {id:'imageryClarity',name:'Esri Clarity imagery',desc:'Archived; try when map data is missing',icon:'satellite_alt',img:'https://clarity.maptiles.arcgis.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1582/654'}
 ]},
 {name:'Topographic',items:[
  {id:'topo',name:'Topographic map',desc:'USGS The National Map',icon:'terrain',img:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/12/1582/654'},
  {id:'topoOpen',name:'OpenTopoMap',desc:'Community topographic map',icon:'terrain',img:'https://tile.opentopomap.org/12/654/1582.png'}
 ]},
 {name:'Light & dark canvas',items:[
  {id:'positron',name:'Positron (light)',desc:'OpenFreeMap vector style',icon:'palette',previewStyle:'https://tiles.openfreemap.org/styles/positron'},
  {id:'esriGray',name:'Esri Light Gray',desc:'Clean canvas map',icon:'draw',img:arcTile('Canvas/World_Light_Gray_Base')},
  {id:'darkMatter',name:'Dark Matter (dark)',desc:'OpenFreeMap vector style',icon:'palette',previewStyle:'https://tiles.openfreemap.org/styles/dark'},
  {id:'esriDarkGray',name:'Esri Dark Gray',desc:'Dark canvas map',icon:'draw',img:arcTile('Canvas/World_Dark_Gray_Base')},
  {id:'esriNatgeo',name:'NatGeo World Map',desc:'National Geographic style',icon:'map',img:arcTile('NatGeo_World_Map')}
 ]},
 {name:'Historical',items:[
  {id:'openHistoricalMap',name:'OpenHistoricalMap',desc:'Historic places & borders, by year',icon:'history',previewStyle:'https://www.openhistoricalmap.org/map-styles/main/main.json'},
  {id:'ohmWoodblock',name:'Woodblock',desc:'Woodblock-print map style, by year',icon:'brush',previewStyle:'https://www.openhistoricalmap.org/map-styles/woodblock/woodblock.json'},
  {id:'ohmJapaneseScroll',name:'Japanese scroll',desc:'Painted scroll style, by year',icon:'auto_stories',previewStyle:'https://www.openhistoricalmap.org/map-styles/japanese_scroll/japanese_scroll.json'},
  {id:'ohmRailway',name:'Railway',desc:'Railways and infrastructure, by year',icon:'train',previewStyle:'https://www.openhistoricalmap.org/map-styles/railway/railway.json'}
 ]},
 {name:'Reference',items:[
  {id:'blank',name:'Blank grid',desc:'Coordinate workspace, works offline',icon:'grid_on',img:null}
 ]}
];
const panel=document.querySelector('#mapStylePanel'),list=document.querySelector('#mapStyleList');
const button=document.querySelector('#mapPickerButton');
const vectorPreviewMaps=new Map();
function build(){list.innerHTML=GROUPS.map(g=>'<section class="msp-group"><h3>'+g.name+'</h3><div class="msp-grid">'+g.items.map(it=>'<button type="button" class="map-choice" role="option" data-map-style="'+it.id+'"><span class="msp-thumb">'+(it.img?'<img src="'+it.img+'" alt="" loading="lazy" data-fallback="'+it.icon+'" aria-hidden="true">':it.previewStyle?'<div class="msp-vector-preview" data-vector-preview="'+it.id+'" aria-label="Live '+it.name+' preview"></div>':'<span class="material-symbols">'+it.icon+'</span>')+'</span><span class="msp-text"><b>'+it.name+'</b><small>'+it.desc+'</small></span><span class="choice-check" aria-hidden="true">\u2713</span></button>').join('')+'</div></section>').join('');list.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{const icon=document.createElement('span');icon.className='material-symbols';icon.textContent=img.dataset.fallback||'map';img.replaceWith(icon)},{once:true}))}
function stopVectorPreviews(){for(const [id,item] of vectorPreviewMaps){clearTimeout(item.timer);try{item.map.remove()}catch{}const node=list.querySelector('[data-vector-preview="'+id+'"]');if(node)delete node.dataset.previewStarted}vectorPreviewMaps.clear()}
function previewUnavailable(id){const item=vectorPreviewMaps.get(id);if(!item)return;clearTimeout(item.timer);try{item.map.remove()}catch{}vectorPreviewMaps.delete(id);const node=list.querySelector('[data-vector-preview="'+id+'"]');if(node){node.classList.add('preview-unavailable');node.innerHTML='<span class="material-symbols">'+item.icon+'</span><small>Preview unavailable</small>'}}
function renderVectorPreviews(){if(!window.maplibregl?.Map)return;for(const group of GROUPS)for(const item of group.items){if(!item.previewStyle||vectorPreviewMaps.has(item.id))continue;const node=list.querySelector('[data-vector-preview="'+item.id+'"]');if(!node)continue;node.dataset.previewStarted='true';node.classList.remove('preview-unavailable','preview-ready');node.replaceChildren();const map=new maplibregl.Map({container:node,style:item.previewStyle,center:[-122.4194,37.7749],zoom:11,interactive:false,attributionControl:false,fadeDuration:0});const entry={map,icon:item.icon,timer:setTimeout(()=>previewUnavailable(item.id),9000)};vectorPreviewMaps.set(item.id,entry);map.on('styleimagemissing',e=>{if(!map.hasImage(e.id))map.addImage(e.id,{width:1,height:1,data:new Uint8Array(4)})});map.once('load',()=>{clearTimeout(entry.timer);node.classList.add('preview-ready')});map.once('error',()=>{if(!node.classList.contains('preview-ready'))previewUnavailable(item.id)})}}
function open(){try{window.northstarApp&&window.northstarApp.syncMapPicker&&window.northstarApp.syncMapPicker()}catch{}panel.hidden=false;document.body.classList.add('map-panel-open');document.body.classList.remove('map-picker-menu-open');button.setAttribute('aria-expanded','true');document.querySelector('#mapPickerMenu').classList.remove('open');requestAnimationFrame(()=>{list.querySelectorAll('img[loading=lazy]').forEach(img=>{img.loading='eager'});renderVectorPreviews()})}
function close(){panel.hidden=true;document.body.classList.remove('map-panel-open');button.setAttribute('aria-expanded','false');stopVectorPreviews()}
document.querySelectorAll('.map-toolbar > .map-choice').forEach(n=>n.remove());
build();
try{window.northstarApp&&window.northstarApp.syncMapPicker&&window.northstarApp.syncMapPicker()}catch{}
button.addEventListener('click',e=>{e.stopImmediatePropagation();panel.hidden?open():close()},true);
document.querySelector('#mapStyleClose').onclick=close;
panel.addEventListener('click',e=>{const b=e.target.closest('[data-map-style]');if(!b)return;const A=window.northstarApp;const style=b.dataset.mapStyle;const S=A.S;const globe=!!(window.northstarCesium&&S.renderer==='globe');const next=globe?window.northstarCesium.globeLayerFor(style):style;S.layer=next;S.mapStyle='street';S.hidden.base=false;A.save();A.draw();if(globe){window.northstarCesium.setBasemap(next);A.syncMapPicker()}else A.refreshBaseLayer();document.querySelectorAll('#mapStylePanel .map-choice').forEach(n=>n.classList.toggle('selected',n.dataset.mapStyle===next));close()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden)close()});
})();
