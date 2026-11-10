import { useRef, useEffect, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import { SearchBox } from '@mapbox/search-js-react'

import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'
import { AircraftFeed } from './flight/AircraftFeed'
import { AircraftLayer } from './flight/AircraftLayer'
import { MapTerrain } from './flight/MapTerrain'
import type { BoundingBox } from './flight/aircraftApi'
import { METERS_PER_DEGREE, metersPerDegreeLng, wrapLongitude } from './flight/geo'
import { useAircraftPolling } from './flight/useAircraftPolling'

const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
const center:[number, number] = [-122.30880, 47.45020]
const MAX_AIRCRAFT = 1000
const TRAIL_MS = 60_000
// Aircraft are drawn this far in the past, so that the positions fetched since then lead them until
// the next poll.
const DISPLAY_DELAY_MS = 60_000
// Smoothed trails are split into as many points as fit.
const MAX_TRAIL_POINTS = 256

// Aircraft are fetched no farther than this from the map's center. A tilted camera sees toward the
// horizon, and this keeps the request near the area the camera is looking at.
const MAX_VIEW_DISTANCE_M = 120_000

// The map's visible area, cut off at `MAX_VIEW_DISTANCE_M` from the center, with longitudes wrapped
// into [-180, 180].
function visibleBounds(map: mapboxgl.Map): BoundingBox {
  const { width, height } = map.getCanvas().getBoundingClientRect()
  const center = map.getCenter()
  const metersPerLng = metersPerDegreeLng(center.lat)
  // Offsets in meters east and north of the center, of points around the edge of the screen.
  const offsets = [0, 0.5, 1]
    .flatMap((x) => [0, 0.5, 1].map((y) => [x * width, y * height] as [number, number]))
    .filter(([x, y]) => x !== width / 2 || y !== height / 2)
    .map((point) => {
      const { lng, lat } = map.unproject(point)
      const east = wrapLongitude(lng - center.lng) * metersPerLng
      const north = (lat - center.lat) * METERS_PER_DEGREE
      const scale = Math.min(1, MAX_VIEW_DISTANCE_M / Math.hypot(east, north))
      return [east * scale, north * scale]
    })
  const easts = offsets.map(([east]) => east)
  const norths = offsets.map(([, north]) => north)
  return [
    wrapLongitude(center.lng + Math.min(...easts) / metersPerLng),
    Math.max(center.lat + Math.min(...norths) / METERS_PER_DEGREE, -90),
    wrapLongitude(center.lng + Math.max(...easts) / metersPerLng),
    Math.min(center.lat + Math.max(...norths) / METERS_PER_DEGREE, 90),
  ]
}

function App() {
  // Set once the map has loaded, to show the search box.
  const [map, setMap] = useState<mapboxgl.Map | null>(null)
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [terrain] = useState(() => new MapTerrain())
  const [feed] = useState(
    () =>
      new AircraftFeed({
        // The trail behind each aircraft as it is drawn, `DISPLAY_DELAY_MS` behind the server's clock.
        historyMs: TRAIL_MS + DISPLAY_DELAY_MS,
        ground: terrain,
      }),
  )
  const { setBounds, setPaused } = useAircraftPolling(feed)

  useEffect(() => {
    const map = new mapboxgl.Map({
      accessToken,
      style: 'mapbox://styles/gpetryk/cmv33q5rh000601t14eqs0uy4',
      container: mapContainerRef.current!,
      center,
      zoom: 13,
      pitch: 60,
    })
    terrain.attach(map)

    const aircraftLayer = new AircraftLayer('aircraft', {
      feed,
      delayMs: DISPLAY_DELAY_MS,
      trailMs: TRAIL_MS,
      origin: center,
      maxAircraft: MAX_AIRCRAFT,
      maxTrailPoints: MAX_TRAIL_POINTS,
    })
    // Aircraft are fetched for the visible area once the map loads, and after every pan, zoom,
    // rotation, tilt and resize.
    map.on('load', () => {
      map.addLayer(aircraftLayer)
      setMap(map)
      setBounds(visibleBounds(map))
    })
    // Polling and terrain updates pause while the camera moves: rebuilding aircraft mid-move would
    // stutter the animation, and the area to fetch is only known once the move ends, which then polls
    // right away.
    map.on('movestart', () => {
      setPaused(true)
      terrain.pause()
    })
    map.on('moveend', () => {
      setPaused(false)
      setBounds(visibleBounds(map))
      terrain.resume()
    })

    return () => {
      setBounds(null)
      setPaused(false)
      setMap(null)
      terrain.detach()
      map.remove()
    }
  }, [feed, terrain, setBounds, setPaused])

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
