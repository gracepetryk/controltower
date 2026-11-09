import { useRef, useEffect, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import { SearchBox } from '@mapbox/search-js-react'

import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'
import { AircraftFeed } from './flight/AircraftFeed'
import { AircraftLayer } from './flight/AircraftLayer'
import { type BoundingBox, wrapLongitude } from './flight/aircraftApi'

const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
const center:[number, number] = [-122.30880, 47.45020]
const MAX_AIRCRAFT = 1000
const TRAIL_MS = 60_000
// Smoothed trails are split into as many points as fit.
const MAX_TRAIL_POINTS = 256

// Aircraft are fetched no farther than this from the map's center. A tilted camera sees toward the
// horizon, and this keeps the request near the area the camera is looking at.
const MAX_VIEW_DISTANCE_M = 120_000
const METERS_PER_DEGREE = 111_320

// The map's visible area, cut off at `MAX_VIEW_DISTANCE_M` from the center, with longitudes wrapped
// into [-180, 180].
function visibleBounds(map: mapboxgl.Map): BoundingBox {
  const { width, height } = map.getCanvas().getBoundingClientRect()
  const center = map.getCenter()
  const metersPerDegreeLng = METERS_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180)
  // Offsets in meters east and north of the center, of points around the edge of the screen.
  const offsets = [0, 0.5, 1]
    .flatMap((x) => [0, 0.5, 1].map((y) => [x * width, y * height] as [number, number]))
    .filter(([x, y]) => x !== width / 2 || y !== height / 2)
    .map((point) => {
      const { lng, lat } = map.unproject(point)
      const east = wrapLongitude(lng - center.lng) * metersPerDegreeLng
      const north = (lat - center.lat) * METERS_PER_DEGREE
      const scale = Math.min(1, MAX_VIEW_DISTANCE_M / Math.hypot(east, north))
      return [east * scale, north * scale]
    })
  const easts = offsets.map(([east]) => east)
  const norths = offsets.map(([, north]) => north)
  return [
    wrapLongitude(center.lng + Math.min(...easts) / metersPerDegreeLng),
    Math.max(center.lat + Math.min(...norths) / METERS_PER_DEGREE, -90),
    wrapLongitude(center.lng + Math.max(...easts) / metersPerDegreeLng),
    Math.min(center.lat + Math.max(...norths) / METERS_PER_DEGREE, 90),
  ]
}

function App() {
  // Set once the map has loaded, to show the search box.
  const [map, setMap] = useState<mapboxgl.Map | null>(null)
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const [inputValue, setInputValue] = useState('')

  useEffect(() => {
    const map = new mapboxgl.Map({
      accessToken,
      style: 'mapbox://styles/gpetryk/cmv33q5rh000601t14eqs0uy4',
      container: mapContainerRef.current!,
      center,
      zoom: 13,
      pitch: 60,
    })

    const aircraftLayer = new AircraftLayer('aircraft', {
      origin: center,
      maxAircraft: MAX_AIRCRAFT,
      maxTrailPoints: MAX_TRAIL_POINTS,
    })
    map.on('load', () => {
      map.addLayer(aircraftLayer)
      setMap(map)
    })

    const feed = new AircraftFeed({
      trailMs: TRAIL_MS,
      bounds: () => visibleBounds(map),
      groundElevation: (lng, lat) => map.queryTerrainElevation([lng, lat]) ?? 0,
    })
    feed.start()

    let frame = requestAnimationFrame(function tick() {
      // Scheduled first so that an error drawing one frame doesn't stop the loop.
      frame = requestAnimationFrame(tick)
      feed.draw(aircraftLayer)
    })

    return () => {
      cancelAnimationFrame(frame)
      feed.stop()
      setMap(null)
      map.remove()
    }
  }, [])

  return (
    <>
        <div style={{
            margin: '10px 10px 0 0',
            width: 300,
            right: 0,
            top: 0,
            position: 'absolute',
            zIndex: 10 }}>
            {map && <SearchBox
                accessToken={accessToken}
                map={map}
                mapboxgl={mapboxgl}
                value={inputValue}
                options={{
                  proximity: center
                }}
                onChange={(d) => {
                    setInputValue(d);
                }}
                marker
            />}
        </div>
        <div id='map-container' ref={mapContainerRef} />
    </>
  )
}

export default App
