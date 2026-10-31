/*
 * Optional 3D globe renderer for Northstar.
 *
 * CesiumJS is loaded on demand so 2D users never download it. The globe uses
 * free raster imagery and an ellipsoid terrain model, so it works without a
 * Cesium ion token or account. Project points, lines and fills are mirrored
 * from northstarApp.S into a private data source. Waypoints can be dragged in
 * 3D and line vertices picked from the globe; each drop is one undoable edit,
 * the same as a drag on the 2D map.
 */
(() => {
  const CESIUM_VERSION = '1.146.0';
  // Loaded from this folder, not a CDN, so the globe works with no connection.
  // The version stays here because the app reports it and Cesium warns when a
  // build's assets do not match the library it loaded.
  const CESIUM_BASE = 'vendor/cesium/Build/Cesium/';
  const CESIUM_SCRIPT = `${CESIUM_BASE}Cesium.js`;
  const CESIUM_STYLES = `${CESIUM_BASE}Widgets/widgets.css`;

  const RASTERS = {
    street: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      maximumLevel: 19,
      credit: '© OpenStreetMap contributors'
    },
    aerial: {
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: 'USGS The National Map'
    },
    imagery: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: 'Esri, Maxar, Earthstar Geographics'
    },
    imageryClarity: {
      url: 'https://clarity.maptiles.arcgis.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: 'Esri, Maxar, Earthstar Geographics'
    },
    topo: {
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 16,
      credit: 'USGS The National Map'
    },
    topoOpen: {
      url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
      maximumLevel: 17,
      credit: '© OpenTopoMap contributors, CC-BY-SA'
    },
    hot: {
      url: 'https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      maximumLevel: 20,
      credit: '© OpenStreetMap contributors, HOT'
    },
    esriGray: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 16,
      credit: 'Esri'
    },
    esriDarkGray: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 16,
      credit: 'Esri'
    },
    esriNatgeo: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 16,
      credit: 'National Geographic, Esri'
    },
    eoxS2: {
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
      maximumLevel: 14,
      credit: 'EOxCloudless by EOX IT Services, Copernicus data, CC BY-NC-SA 4.0'
    }
  };

  // MapLibre-only styles are shown on the globe as the closest free raster look
  // instead of silently failing. Blank stays blank so offline use remains honest.
  const GLOBE_ALIASES = {
    openmaptiles: 'street',
    openTopoVector: 'topoOpen',
    positron: 'esriGray',
    darkMatter: 'esriDarkGray',
    naip: 'aerial',
    openHistoricalMap: 'street',
    ohmWoodblock: 'street',
    ohmJapaneseScroll: 'street',
    ohmRailway: 'street'
  };

  let loadPromise = null;
  let viewer = null;
  let dataSource = null;
  let active = false;
  let activationToken = 0;
  let clickHandler = null;
  let pressPosition = null;
  let dragCandidate = null;
  let lastDataStamp = '';
  let lastBaseLayer = '';
  let moveSaveTimer = 0;
  let startingView = false;
  let terrainActive = false;

  const app = () => window.northstarApp;
  const canvasHost = () => document.querySelector('#cesiumMap');
  const message = (text) => {
    try { app()?.message?.(text); } catch {}
  };

  function globeLayerFor(layer) {
    if (layer === 'blank') return 'blank';
    if (RASTERS[layer]) return layer;
    return GLOBE_ALIASES[layer] || 'street';
  }

  function ensureCesium() {
    if (window.Cesium?.Viewer) return Promise.resolve(window.Cesium);
    if (loadPromise) return loadPromise;

    window.CESIUM_BASE_URL = CESIUM_BASE;
    loadPromise = new Promise((resolve, reject) => {
      let style = document.querySelector('#cesiumWidgetsStyles');
      if (!style) {
        style = document.createElement('link');
        style.id = 'cesiumWidgetsStyles';
        style.rel = 'stylesheet';
        style.href = CESIUM_STYLES;
        document.head.appendChild(style);
      }

      const removeScript = () => document.querySelector('script[data-northstar-cesium]')?.remove();
      const timer = setTimeout(() => {
        removeScript();
        reject(new Error('CesiumJS download timed out.'));
      }, 25000);
      const finish = () => {
        clearTimeout(timer);
        if (window.Cesium?.Viewer) resolve(window.Cesium);
        else reject(new Error('CesiumJS loaded without a Viewer API.'));
      };
      const fail = () => {
        clearTimeout(timer);
        removeScript();
        reject(new Error('CesiumJS could not be downloaded.'));
      };
      const existing = document.querySelector('script[data-northstar-cesium]');
      if (existing) {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', fail, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = CESIUM_SCRIPT;
      script.async = true;
      script.dataset.northstarCesium = 'true';
      script.onload = finish;
      script.onerror = fail;
      document.head.appendChild(script);
    }).catch((error) => {
      loadPromise = null;
      throw error;
    });
    return loadPromise;
  }

  function zoomToHeight(lat, zoom) {
    const canvasHeight = viewer?.scene?.canvas?.clientHeight || window.innerHeight || 800;
    const fov = viewer?.camera?.frustum?.fovy || Math.PI / 3;
    const metersPerPixel = 40075016.686 * Math.max(0.08, Math.cos(lat * Math.PI / 180)) / (256 * 2 ** zoom);
    const groundHeight = metersPerPixel * canvasHeight;
    return Math.max(35, groundHeight / (2 * Math.tan(fov / 2)));
  }

  function cameraZoom() {
    if (!viewer) return app()?.S?.zoom || 15;
    const Cesium = window.Cesium;
    try {
      const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
      if (rectangle) {
        const lonSpan = Cesium.Math.toDegrees(rectangle.east - rectangle.west);
        const canvasWidth = viewer.scene.canvas.clientWidth || window.innerWidth || 1000;
        if (lonSpan > 0 && lonSpan < 359) {
          const zoom = Math.log2(360 * canvasWidth / (256 * lonSpan));
          if (Number.isFinite(zoom)) return Math.max(2, Math.min(23, zoom));
        }
      }
    } catch {}
    const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    if (!carto) return app()?.S?.zoom || 15;
    const height = Math.max(10, carto.height);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const canvasHeight = viewer.scene.canvas.clientHeight || window.innerHeight || 800;
    const fov = viewer.camera.frustum.fovy || Math.PI / 3;
    const groundHeight = 2 * height * Math.tan(fov / 2);
    const metersPerPixel = groundHeight / Math.max(1, canvasHeight);
    const zoom = Math.log2(40075016.686 * Math.max(0.08, Math.cos(lat * Math.PI / 180)) / (256 * metersPerPixel));
    return Math.max(2, Math.min(23, zoom));
  }

  function cameraCenter() {
    if (!viewer) return null;
    const Cesium = window.Cesium;
    const canvas = viewer.scene.canvas;
    const center = Cesium.Cartesian2.fromElements(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ground = pickGround(center);
    const carto = ground ? Cesium.Cartographic.fromCartesian(ground) : Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude)
    };
  }

  function providerFor(layer) {
    const spec = RASTERS[layer];
    if (!spec) return null;
    return new window.Cesium.UrlTemplateImageryProvider({
      url: spec.url,
      maximumLevel: spec.maximumLevel,
      credit: new window.Cesium.Credit(spec.credit)
    });
  }

  async function applyTerrain() {
    if (!viewer) return;
    const Cesium = window.Cesium;
    const settings = app()?.settings || {};
    const token = String(settings.cesiumIonToken || '').trim();
    const wanted = settings.cesiumTerrain === true && !!token;

    if (!wanted) {
      terrainActive = false;
      Cesium.Ion.defaultAccessToken = undefined;
      viewer.scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
      viewer.scene.requestRender();
      return;
    }

    Cesium.Ion.defaultAccessToken = token;
    try {
      const terrain = Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true });
      viewer.scene.setTerrain(terrain);
      if (terrain.readyPromise) await terrain.readyPromise;
      terrainActive = true;
      viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
      viewer.scene.requestRender();
    } catch (error) {
      terrainActive = false;
      viewer.scene.setTerrain(undefined);
      viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
      viewer.scene.requestRender();
      message('Cesium World Terrain is unavailable · check the ion token or connection');
    }
  }

  async function refreshTerrain() {
    if (!active) return;
    await applyTerrain();
    const S = app()?.S;
    if (S?.center) setView(+S.center.lat, +S.center.lon, +S.zoom || 15, false);
  }

  function pickGround(windowPosition) {
    if (!viewer) return null;
    const Cesium = window.Cesium;
    const ray = viewer.camera.getPickRay(windowPosition);
    const ground = ray ? viewer.scene.globe.pick(ray, viewer.scene) : null;
    return ground || viewer.camera.pickEllipsoid(windowPosition, viewer.scene.globe.ellipsoid);
  }

  function applyBasemap(layer, force = false) {
    if (!viewer) return;
    const target = globeLayerFor(layer);
    if (!force && target === lastBaseLayer) return;
    lastBaseLayer = target;
    viewer.imageryLayers.removeAll();
    viewer.scene.globe.baseColor = window.Cesium.Color.fromCssColorString('#10151c');
    if (target === 'blank') {
      viewer.scene.globe.show = true;
    } else {
      const provider = providerFor(target);
      if (provider) viewer.imageryLayers.addImageryProvider(provider);
    }
    viewer.scene.requestRender();
  }

  function setStatusReady() {
    const label = document.querySelector('#statusText');
    const error = document.querySelector('#mapError');
    if (error) error.hidden = true;
    if (label) label.textContent = '3D globe · drag to orbit, scroll to zoom';
  }

  function createViewer(Cesium) {
    const host = canvasHost();
    if (!host) throw new Error('The 3D globe container is missing.');

    const credits = document.createElement('div');
    credits.className = 'cesium-credits';
    credits.id = 'cesiumCredits';
    host.appendChild(credits);

    const initial = app()?.S || { center: { lat: 37.7749, lon: -122.4194 }, zoom: 15, layer: 'street' };
    const provider = providerFor(globeLayerFor(initial.layer));
    viewer = new Cesium.Viewer(host, {
      baseLayer: provider ? new Cesium.ImageryLayer(provider) : false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      infoBox: false,
      selectionIndicator: false,
      creditContainer: credits,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      shouldAnimate: false
    });

    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 25;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 24000000;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

    dataSource = new Cesium.CustomDataSource('northstar-project');
    viewer.dataSources.add(dataSource);

    // Cesium only reports LEFT_CLICK when the pointer does not move at all
    // between press and release, so a normal trackpad wobble turned every click
    // into nothing. Treat a short press-and-release as a click ourselves and
    // leave real camera drags alone.
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((movement) => {
      pressPosition = movement.position;
      dragCandidate = beginPointDrag(movement.position);
      if (dragCandidate) viewer.scene.canvas.style.cursor = 'grabbing';
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    clickHandler.setInputAction((movement) => {
      const start = pressPosition;
      pressPosition = null;
      const end = movement.position;
      if (dragCandidate) {
        const dragged = endPointDrag();
        viewer.scene.canvas.style.cursor = '';
        if (dragged) return;
      }
      if (!start || !end) return;
      if (Math.hypot(end.x - start.x, end.y - start.y) > 6) return;
      handleClick(end);
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
    clickHandler.setInputAction((movement) => {
      if (dragCandidate) updatePointDrag(movement.endPosition);
      const point = pickGround(movement.endPosition);
      if (point) {
        const carto = Cesium.Cartographic.fromCartesian(point);
        app()?.updateGeoStatus?.(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
      }
      // Show that waypoints can be grabbed without having to click one first.
      if (!dragCandidate) {
        const grabbable = app()?.S?.tool === 'select' && nearestPointId(movement.endPosition, 12);
        viewer.scene.canvas.style.cursor = grabbable ? 'grab' : '';
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    // Releasing outside the canvas, or leaving the window mid-drag, must not
    // leave the camera controller stuck without rotation.
    window.addEventListener('blur', () => {
      pressPosition = null;
      if (dragCandidate) endPointDrag();
      if (viewer) viewer.scene.canvas.style.cursor = '';
    });
    clickHandler.setInputAction(() => saveCamera(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    viewer.camera.moveEnd.addEventListener(() => {
      if (!active) return;
      clearTimeout(moveSaveTimer);
      moveSaveTimer = setTimeout(saveCamera, 350);
    });

    applyBasemap(initial.layer, true);
    setView(initial.center.lat, initial.center.lon, initial.zoom, false);
  }

  // Billboards are small targets on a 3D globe, and pin symbols sit above their
  // coordinate, so a picked entity is not the only way to hit a waypoint. When
  // nothing is picked, fall back to the nearest waypoint within a few pixels.
  function nearestPointId(position, radius = 22) {
    const Cesium = window.Cesium;
    const S = app()?.S;
    if (!Cesium || !viewer || !S || S.hidden?.points === true) return '';
    let best = '';
    let bestDistance = radius;
    S.points.forEach((point) => {
      const lat = +point.lat;
      const lon = +point.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        Cesium.Cartesian3.fromDegrees(lon, lat)
      );
      if (!screen) return;
      const y = screen.y - (point.symbol === 'pin' ? 7 : 0);
      const distance = Math.hypot(screen.x - position.x, y - position.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point.id;
      }
    });
    return best;
  }

  function pickedId(position) {
    const picked = viewer?.scene?.pick(position);
    return picked?.id && typeof picked.id.id === 'string' ? picked.id.id : '';
  }

  function screenForPoint(point) {
    const Cesium = window.Cesium;
    if (!Cesium || !viewer) return null;
    return Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      Cesium.Cartesian3.fromDegrees(+point.lon, +point.lat)
    );
  }

  // Only the Select tool drags waypoints, exactly like the 2D map. The Point
  // and Line tools keep their click behaviour so a stray press cannot nudge a
  // coordinate while collecting.
  function draggablePointAt(position) {
    const S = app()?.S;
    if (!S || S.tool !== 'select' || S.hidden?.points === true) return null;
    const entityId = pickedId(position);
    const pointId = entityId.startsWith('point:')
      ? entityId.slice(6)
      : (entityId ? '' : nearestPointId(position, 12));
    if (!pointId) return null;
    const point = S.points.find((item) => item.id === pointId);
    if (!point) return null;
    const screen = screenForPoint(point);
    return {
      id: pointId,
      startX: position.x,
      startY: position.y,
      startLat: +point.lat,
      startLon: +point.lon,
      // Keep the grab offset so the coordinate does not jump under the cursor.
      offsetX: screen ? screen.x - position.x : 0,
      offsetY: screen ? screen.y - position.y : 0,
      moved: false,
      frame: 0
    };
  }

  function releaseRotate() {
    if (viewer) viewer.scene.screenSpaceCameraController.enableRotate = true;
  }

  function dragTip() {
    const host = canvasHost();
    if (!host) return null;
    let tip = host.querySelector('#cesiumDragTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'cesiumDragTip';
      tip.hidden = true;
      host.appendChild(tip);
    }
    return tip;
  }

  // The readout is anchored to the waypoint's live position, not the pointer,
  // so the coordinate stays readable when the grab point is off-centre.
  function showDragTip(point) {
    const tip = dragTip();
    if (!tip) return;
    const screen = screenForPoint(point);
    if (!screen) {
      tip.hidden = true;
      return;
    }
    if (!tip.firstChild) tip.append(document.createElement('small'), document.createTextNode(''));
    tip.firstChild.textContent = point.name;
    tip.lastChild.nodeValue = (+point.lat).toFixed(6) + ', ' + (+point.lon).toFixed(6);
    tip.style.left = screen.x + 'px';
    tip.style.top = screen.y + 'px';
    tip.hidden = false;
  }

  function hideDragTip() {
    const tip = canvasHost()?.querySelector('#cesiumDragTip');
    if (tip) tip.hidden = true;
  }

  function beginPointDrag(position) {
    const candidate = draggablePointAt(position);
    if (!candidate) return null;
    // Stop the globe from orbiting under the pointer while a waypoint is held.
    viewer.scene.screenSpaceCameraController.enableRotate = false;
    return candidate;
  }

  function updatePointDrag(position) {
    if (!dragCandidate) return;
    if (!dragCandidate.moved) {
      if (Math.hypot(position.x - dragCandidate.startX, position.y - dragCandidate.startY) < 4) return;
      dragCandidate.moved = true;
      // Selecting the point being moved matches the 2D drag, so the tree and
      // properties panel follow the coordinate as it changes.
      const active = app()?.S;
      if (active) active.selected = dragCandidate.id;
    }
    const Cesium = window.Cesium;
    const S = app()?.S;
    const point = S && S.points.find((item) => item.id === dragCandidate.id);
    if (!point) return;
    const target = pickGround({ x: position.x + dragCandidate.offsetX, y: position.y + dragCandidate.offsetY });
    if (!target) return;
    const carto = Cesium.Cartographic.fromCartesian(target);
    if (!carto) return;
    point.lat = Cesium.Math.toDegrees(carto.latitude);
    point.lon = Cesium.Math.toDegrees(carto.longitude);
    showDragTip(point);
    if (!dragCandidate.frame) {
      dragCandidate.frame = requestAnimationFrame(() => {
        if (!dragCandidate) return;
        dragCandidate.frame = 0;
        app()?.draw?.();
      });
    }
  }

  function endPointDrag() {
    const candidate = dragCandidate;
    dragCandidate = null;
    releaseRotate();
    hideDragTip();
    if (!candidate) return false;
    if (candidate.frame) cancelAnimationFrame(candidate.frame);
    if (!candidate.moved) return false;
    const S = app()?.S;
    const point = S && S.points.find((item) => item.id === candidate.id);
    if (!point) return true;
    if (Math.abs(point.lat - candidate.startLat) < 1e-12 && Math.abs(point.lon - candidate.startLon) < 1e-12) {
      app()?.draw?.();
      return true;
    }
    // pushHistory stores the post-drag state, so Ctrl+Z restores the pre-drag
    // coordinate exactly as it does for a drag on the 2D map.
    app()?.pushHistory?.('move point');
    app()?.save?.();
    // select() refreshes the properties panel, tree and drawing, so the drop
    // commits once instead of redrawing three times.
    app()?.select?.(point.id);
    message(point.name + ' moved to ' + point.lat.toFixed(6) + ', ' + point.lon.toFixed(6));
    return true;
  }

  function handleClick(position) {
    if (!viewer || !active) return;
    const S = app()?.S;
    if (!S) return;

    if (S.tool === 'point') {
      addPointAt(position);
      return;
    }

    const entityId = pickedId(position);
    const pointId = entityId.startsWith('point:')
      ? entityId.slice(6)
      : (entityId ? '' : nearestPointId(position));

    if (S.tool === 'line') {
      if (!pointId) {
        message('Click a waypoint to start or extend a line. Use Vector GL or Raster for freehand drawing.');
        return;
      }
      app()?.linePick?.(pointId);
      return;
    }

    if (pointId) {
      app()?.select?.(pointId);
      return;
    }
    if (entityId.startsWith('line-fill:') || entityId.startsWith('line:')) {
      app()?.select?.(entityId.replace(/^line-fill:/, '').replace(/^line:/, ''));
      return;
    }
    if (S.tool === 'select') app()?.select?.(null);
  }

  function addPointAt(position) {
    const Cesium = window.Cesium;
    const picked = pickGround(position);
    if (!picked) return;
    const carto = Cesium.Cartographic.fromCartesian(picked);
    app()?.add?.({
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude)
    });
  }

  function saveCamera() {
    const S = app()?.S;
    if (!active || !S || startingView) return;
    const center = cameraCenter();
    if (!center) return;
    S.center = center;
    S.zoom = Math.round(cameraZoom() * 100) / 100;
    app()?.save?.();
  }

  /** The waypoint dot, matching the 2D map's point size setting. */
  function markerSize(selected) {
    const value = app()?.settings?.pointSize;
    const base = value === 'small' ? 11 : value === 'large' ? 20 : 14;
    return base + (selected ? 3 : 0);
  }

  function symbolImage(point, selected) {
    const appApi = app();
    if (appApi?.pointSymbolSVG) {
      const color = selected ? '#f47752' : (app()?.settings?.pointColor || '#3478f6');
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(appApi.pointSymbolSVG(point.symbol, color, selected, markerSize(selected)));
    }
    return undefined;
  }

  function labelText(point) {
    return point.showLabel
      ? `${point.name}\n${(+point.lat).toFixed(5)}, ${(+point.lon).toFixed(5)}`
      : point.name;
  }

  function colorFor(value, fallback) {
    return window.Cesium.Color.fromCssColorString(value || fallback) || window.Cesium.Color.fromCssColorString(fallback);
  }

  function renderProject() {
    if (!viewer || !dataSource) return;
    const Cesium = window.Cesium;
    const S = app()?.S;
    if (!S) return;

    const stamp = JSON.stringify([
      S.points.map((p) => [p.id, p.name, p.lat, p.lon, p.symbol, p.showLabel === true]),
      S.lines.map((line) => [line.id, line.name, line.ids, line.closed, line.color]),
      S.selected,
      S.hidden?.points === true,
      S.hidden?.boundary === true,
      app()?.settings?.pointSize,
      app()?.settings?.pointColor
    ]);
    if (stamp === lastDataStamp) return;
    lastDataStamp = stamp;
    dataSource.entities.removeAll();

    if (S.hidden?.points !== true) {
      S.points.forEach((point) => {
        if (!Number.isFinite(+point.lat) || !Number.isFinite(+point.lon)) return;
        const selected = S.selected === point.id;
        const image = symbolImage(point, selected);
        dataSource.entities.add({
          id: 'point:' + point.id,
          position: Cesium.Cartesian3.fromDegrees(+point.lon, +point.lat),
          billboard: {
            image,
            width: markerSize(selected),
            height: markerSize(selected),
            verticalOrigin: point.symbol === 'pin' ? Cesium.VerticalOrigin.BOTTOM : Cesium.VerticalOrigin.CENTER,
            scaleByDistance: new Cesium.NearFarScalar(100, 1.15, 300000, 0.75)
          },
          label: {
            text: labelText(point),
            show: point.showLabel === true || selected,
            font: '600 13px Roboto, Arial, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.fromCssColorString('#10151c'),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -22),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#10151c').withAlpha(0.76),
            backgroundPadding: new Cesium.Cartesian2(8, 5),
            scaleByDistance: new Cesium.NearFarScalar(200, 1, 500000, 0.7)
          }
        });
      });
    }

    if (S.hidden?.boundary !== true) {
      S.lines.forEach((line) => {
        const points = (line.ids || [])
          .map((id) => S.points.find((point) => point.id === id))
          .filter(Boolean);
        if (points.length < 2) return;
        const positions = points.map((point) => Cesium.Cartesian3.fromDegrees(+point.lon, +point.lat));
        const selected = S.selected === line.id;
        const color = colorFor(line.color, '#21a67a');

        if (line.closed && positions.length >= 3) {
          dataSource.entities.add({
            id: 'line-fill:' + line.id,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions),
              material: color.withAlpha(selected ? 0.28 : 0.16),
              outline: false,
              height: 0
            }
          });
        }

        dataSource.entities.add({
          id: 'line:' + line.id,
          polyline: {
            positions: line.closed ? positions.concat([positions[0]]) : positions,
            width: selected ? 5 : 2.5,
            material: color,
            arcType: Cesium.ArcType.GEODESIC
          }
        });
      });
    }

    if (typeof S.selected === 'string' && S.selected.startsWith('segment:')) {
      const [from, to] = S.selected.slice(8).split('|');
      const a = S.points.find((point) => point.id === from);
      const b = S.points.find((point) => point.id === to);
      if (a && b) {
        dataSource.entities.add({
          id: 'measurement-segment',
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([+a.lon, +a.lat, +b.lon, +b.lat]),
            width: 5,
            material: Cesium.Color.fromCssColorString('#f47752'),
            arcType: Cesium.ArcType.GEODESIC
          }
        });
      }
    }

    viewer.scene.requestRender();
  }

  function setView(lat, lon, zoom, animate = true) {
    if (!viewer) return;
    startingView = true;
    let ground = 0;
    if (terrainActive) {
      const Cesium = window.Cesium;
      const height = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat));
      ground = Number.isFinite(height) ? height : 600;
    }
    const destination = window.Cesium.Cartesian3.fromDegrees(lon, lat, ground + zoomToHeight(lat, zoom));
    const orientation = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
    if (animate) {
      viewer.camera.flyTo({
        destination,
        orientation,
        duration: 0.8,
        complete: () => { startingView = false; }
      });
    } else {
      viewer.camera.setView({ destination, orientation });
      startingView = false;
    }
  }

  function focus(lat, lon, zoom = 16) {
    setView(lat, lon, zoom, true);
  }

  function fitPoints(points) {
    const S = app()?.S;
    if (!S || !viewer) return;
    const valid = (points || []).filter((point) => Number.isFinite(+point.lat) && Number.isFinite(+point.lon));
    if (!valid.length) return;
    if (valid.length === 1) {
      S.center = { lat: +valid[0].lat, lon: +valid[0].lon };
      S.zoom = Math.max(S.zoom || 15, 17);
      app()?.save?.();
      focus(S.center.lat, S.center.lon, S.zoom);
      return;
    }
    const lats = valid.map((point) => +point.lat);
    const lons = valid.map((point) => +point.lon);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    S.center = { lat: (south + north) / 2, lon: (west + east) / 2 };
    S.zoom = 15;
    app()?.save?.();
    viewer.camera.flyTo({
      destination: window.Cesium.Rectangle.fromDegrees(west, south, east, north),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      duration: 0.9
    });
  }

  function fit() {
    fitPoints(app()?.S?.points || []);
  }

  function zoom(delta) {
    if (!viewer) return;
    const center = cameraCenter();
    if (!center) return;
    const next = Math.max(3, Math.min(20, cameraZoom() + delta));
    setView(center.lat, center.lon, next, true);
  }

  async function activate(options = {}) {
    if (active) return;
    const token = ++activationToken;
    message('Loading 3D globe…');
    try {
      const Cesium = await ensureCesium();
      if (token !== activationToken) return;
      if (!viewer) createViewer(Cesium);
      if (token !== activationToken) return;

      active = true;
      const appApi = app();
      if (appApi?.S) {
        appApi.S.layer = globeLayerFor(appApi.S.layer);
        appApi.S.renderer = 'globe';
        appApi.save?.();
        appApi.syncMapPicker?.();
      }

      const host = canvasHost();
      if (host) host.hidden = false;
      document.body.classList.add('globe-engine');
      viewer.useDefaultRenderLoop = true;
      viewer.resize();
      applyBasemap(appApi?.S?.layer || 'street', true);
      await applyTerrain();
      const saved = appApi?.S;
      if (saved?.center) setView(+saved.center.lat, +saved.center.lon, +saved.zoom || 15, false);
      lastDataStamp = '';
      renderProject();
      setStatusReady();
      appApi?.draw?.();
      if (!options.silent) message('3D globe · drag to orbit, scroll to zoom');
    } catch (error) {
      if (token !== activationToken) return;
      active = false;
      document.body.classList.remove('globe-engine');
      const appApi = app();
      if (appApi?.S) {
        appApi.S.renderer = 'raster';
        appApi.syncMapPicker?.();
      }
      appApi?.draw?.();
      appApi?.refreshBaseLayer?.();
      message((error && error.message ? error.message : '3D globe unavailable') + ' · using the 2D map');
    }
  }

  function deactivate() {
    activationToken += 1;
    clearTimeout(moveSaveTimer);
    dragCandidate = null;
    pressPosition = null;
    releaseRotate();
    hideDragTip();
    if (viewer) viewer.scene.canvas.style.cursor = '';
    if (active) saveCamera();
    active = false;
    document.body.classList.remove('globe-engine');
    const host = canvasHost();
    if (host) host.hidden = true;
    if (viewer) viewer.useDefaultRenderLoop = false;
    app()?.syncMapPicker?.();
  }

  function sync() {
    if (!active || !viewer) return;
    const S = app()?.S;
    if (!S) return;
    if (globeLayerFor(S.layer) !== lastBaseLayer) applyBasemap(S.layer);
    renderProject();
  }

  window.northstarCesium = {
    version: CESIUM_VERSION,
    isActive: () => active,
    activate,
    deactivate,
    refreshTerrain,
    sync,
    setBasemap: (layer) => applyBasemap(layer, true),
    globeLayerFor,
    focus,
    fit,
    fitPoints,
    zoom,
    getZoom: cameraZoom,
    viewer: () => viewer
  };
})();
