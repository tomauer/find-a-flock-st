import { useCallback, useEffect, useMemo, useRef } from 'react';
import Map, { Marker, useControl, type MapRef } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent } from 'react-map-gl/maplibre';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { GeoJsonLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { BBox, Geometry, LngLat } from '../types';

// Dark basemap WITH place labels (cities, states, countries, water bodies) so you
// can orient by geography while still recalling where the species overlap. Terrain
// relief is layered on separately (see addHillshade).
const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Free, key-less global DEM (Mapzen/AWS Terrain Tiles, terrarium-encoded). Used
// for a 2-D hillshade — the map is locked top-down, so elevation reads as shaded
// relief, not 3-D. https://registry.opendata.aws/terrain-tiles/
const DEM_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Add a shaded-relief hillshade beneath the basemap's labels (idempotent). */
function addHillshade(map: MaplibreMap) {
  if (map.getSource('terrain-dem')) return;
  map.addSource('terrain-dem', {
    type: 'raster-dem',
    tiles: [DEM_TILES],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 13,
    attribution:
      'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen/AWS Terrain Tiles</a>',
  });
  // Slot the relief above the base fills but below the first label (symbol) layer,
  // so mountains get shaded while city names stay legible on top.
  const firstSymbol = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
  map.addLayer(
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-exaggeration': 0.6,
        'hillshade-shadow-color': '#05070d',
        'hillshade-highlight-color': '#9aa6bd',
        'hillshade-accent-color': '#05070d',
      },
    },
    firstSymbol,
  );
}

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

interface Props {
  answer?: Geometry | null; // revealed overlap region (post-guess only)
  guess?: LngLat | null;
  fitBBox?: BBox | null;
  onMapClick?: (ll: LngLat) => void;
}

const INITIAL = { longitude: -95, latitude: 44, zoom: 2.6 };

export default function MapView({
  answer,
  guess,
  fitBBox,
  onMapClick,
}: Props) {
  const mapRef = useRef<MapRef | null>(null);

  const fit = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map || !fitBBox) return;
    map.fitBounds(
      [
        [fitBBox[0], fitBBox[1]],
        [fitBBox[2], fitBBox[3]],
      ],
      { padding: 64, duration: 600, maxZoom: 6 },
    );
  }, [fitBBox]);

  useEffect(() => {
    fit();
  }, [fit]);

  const handleLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (map) addHillshade(map);
    fit();
  }, [fit]);

  const layers = useMemo(() => {
    if (!answer) return [];
    return [
      new GeoJsonLayer({
        id: 'answer',
        data: { type: 'Feature', geometry: answer, properties: {} },
        stroked: true,
        filled: true,
        // Firmer fill, faint thin outline: real absent-cell holes read as soft
        // texture rather than glowing hexagons (the outline used to ring every
        // interior pinhole). Overlap math is unaffected — this is display only.
        getFillColor: [110, 231, 183, 140],
        getLineColor: [110, 231, 183, 90],
        lineWidthUnits: 'pixels',
        getLineWidth: 0.75,
        lineWidthMinPixels: 0.75,
        pickable: false,
      }),
    ];
  }, [answer]);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      if (onMapClick) onMapClick([e.lngLat.lng, e.lngLat.lat]);
    },
    [onMapClick],
  );

  return (
    <Map
      ref={mapRef}
      initialViewState={INITIAL}
      mapStyle={BASEMAP}
      onLoad={handleLoad}
      onClick={onMapClick ? handleClick : undefined}
      dragRotate={false}
      touchPitch={false}
      attributionControl={true}
      style={{ position: 'absolute', inset: 0 }}
    >
      <DeckOverlay layers={layers} interleaved={false} />
      {guess && (
        <Marker longitude={guess[0]} latitude={guess[1]} anchor="bottom">
          <div className="text-2xl drop-shadow-lg">📍</div>
        </Marker>
      )}
    </Map>
  );
}
