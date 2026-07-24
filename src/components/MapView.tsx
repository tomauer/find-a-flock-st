import { useCallback, useEffect, useMemo, useRef } from 'react';
import Map, { Marker, useControl, type MapRef } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent } from 'react-map-gl/maplibre';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { GeoJsonLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { BBox, Geometry, LngLat } from '../types';

// Coastlines + country/state borders, but no place labels: you place the flock
// from range knowledge, not by reading city names off the map.
const BASEMAP =
  'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

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

  const layers = useMemo(() => {
    if (!answer) return [];
    return [
      new GeoJsonLayer({
        id: 'answer',
        data: { type: 'Feature', geometry: answer, properties: {} },
        stroked: true,
        filled: true,
        getFillColor: [110, 231, 183, 90],
        getLineColor: [110, 231, 183, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 2.5,
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
      onLoad={fit}
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
