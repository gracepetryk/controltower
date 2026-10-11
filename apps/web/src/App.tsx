import { useRef, useEffect, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import { SearchBox } from '@mapbox/search-js-react'

import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'
import { AircraftFeed } from './flight/AircraftFeed'
import { AircraftLayer } from './flight/AircraftLayer'
import type { BoundingBox } from './flight/aircraftApi'

const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
const center:[number, number] = [-122.30880, 47.45020]
const MAX_AIRCRAFT = 1000
const TRAIL_MS = 60_000
// Smoothed trails are split into as many points as fit.
const MAX_TRAIL_POINTS = 256

// The map's visible area, with longitudes wrapped into [-180, 180].
function visibleBounds(map: mapboxgl.Map): BoundingBox {
  const bounds = map.getBounds()!
  if (bounds.getEast() - bounds.getWest() >= 360) {
    return [-180, bounds.getSouth(), 180, bounds.getNorth()]
  }
  const wrap = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180
  return [wrap(bounds.getWest()), bounds.getSouth(), wrap(bounds.getEast()), bounds.getNorth()]
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
