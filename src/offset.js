(()=>{
const A=window.northstarApp;if(!A)return;
const $=s=>document.querySelector(s);
const dlg=$('#offsetDialog');
function openOffset(){const S=A.S;const sel=$('#offsetLine');const lines=S.lines.filter(l=>l.ids.length>=2);
 if(!lines.length)return A.message('Draw a line with at least two waypoints first');
 sel.innerHTML=lines.map(l=>'<option value="'+l.id+'">'+l.name.replace(/</g,'&lt;')+'</option>').join('');
 const pre=S.lines.find(l=>l.id===S.selected);if(pre&&lines.includes(pre))sel.value=pre.id;
 dlg.showModal();}
function create(){const S=A.S;const line=S.lines.find(l=>l.id===$('#offsetLine').value);const d=Number($('#offsetDistance').value);
 if(!line)return A.message('Choose a line');if(!(d>0))return A.message('Enter a distance greater than zero');
 const pts=line.ids.map(id=>S.points.find(p=>p.id===id)).filter(Boolean);if(pts.length<2)return A.message('That line needs two waypoints');
 const coords=pts.map(p=>[p.lon,p.lat]);const closed=!!line.closed&&pts.length>2;
 let geom=coords;if(closed)geom=coords.concat([coords[0]]);
 const side=$('#offsetSide').value==='left'?d:-d;
 const off=turf.lineOffset(turf.lineString(geom),side,{units:'meters'}).geometry.coordinates;
 let out=off;if(closed&&out.length>1)out=out.slice(0,-1);
 const ids=out.map((c,i)=>{const id=String(Date.now()+Math.random())+'-'+i;S.points.push({id,name:line.name+' offset '+(i+1),lat:c[1],lon:c[0]});return id});
 const name=line.name+' offset '+d+' m';
 S.lines.push({id:'line-'+Date.now(),name,ids,closed});
 S.selected=S.lines[S.lines.length-1].id;
 A.pushHistory('offset line');A.save();A.draw();A.inspect();dlg.close();A.message('Offset line created with '+ids.length+' waypoints');}
$('#offsetCreate').onclick=create;$('#offsetCancel').onclick=$('#offsetClose').onclick=()=>dlg.close();
document.querySelector('#toolsMenuPanel').addEventListener('click',e=>{const it=e.target.closest('[data-tools-action="offset"]');if(!it)return;document.querySelector('#toolsMenuPanel').hidden=true;openOffset()});
})();
