/* Which 2D renderer draws what.
 *
 * Northstar has three engines and uses whichever one suits the layer, without
 * asking: raster imagery through Leaflet's tile layer (plain images, and it
 * speaks the bbox templates some ArcGIS services need), vector styles through
 * MapLibre, and the globe through Cesium. Nothing here draws; it answers the
 * question the interface asks while switching basemaps.
 */
(function () {
  'use strict';

  var RASTER = [
    'street', 'hot', 'eoxS2', 'aerial', 'naip', 'imagery', 'imageryClarity',
    'topo', 'topoOpen', 'esriGray', 'esriDarkGray', 'esriNatgeo'
  ];
  var VECTOR = [
    'openmaptiles', 'openTopoVector', 'positron', 'darkMatter',
    'openHistoricalMap', 'ohmWoodblock', 'ohmJapaneseScroll', 'ohmRailway'
  ];

  function kind(layer) {
    if (!layer || layer === 'blank') return 'blank';
    if (RASTER.indexOf(layer) >= 0) return 'raster';
    if (VECTOR.indexOf(layer) >= 0) return 'vector';
    return 'vector';
  }

  function rasterEngine() {
    return window.L && window.L.tileLayer ? 'leaflet' : 'maplibre';
  }

  window.northstarRenderers = {
    kind: kind,
    rasterEngine: rasterEngine,
    /* The 2D engine for a layer: a raster basemap goes to Leaflet's tiles when
       Leaflet is there, a vector style to MapLibre. A raster basemap the tile
       layer cannot express (nothing today) still has the MapLibre path. */
    pick: function (layer) {
      if (kind(layer) === 'raster') return rasterEngine();
      return window.L && window.L.maplibreGL ? 'maplibre' : 'leaflet';
    },
    label: function (engine) {
      return engine === 'leaflet' ? 'tile renderer' : 'MapLibre GL';
    }
  };
})();
