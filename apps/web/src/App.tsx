import { useRef, useEffect, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import { SearchBox } from '@mapbox/search-js-react'

import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'
import { PlaneLayer } from './flight/PlaneLayer'
import { orbitPosition } from './flight/simulatedFlight'

const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
const center:[number, number] = [-122.30880, 47.45020]

const simulatedOrbit = {
  center,
  radiusMeters: 3000,
  lapMs: 90_000,
  altitudeMeters: 900,
  altitudeSwingMeters: 300,
}

function App() {
  const mapRef = useRef<mapboxgl.Map | null>(null)
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
    mapRef.current = map

    const planeLayer = new PlaneLayer('plane', center)
    map.on('load', () => map.addLayer(planeLayer))

    let frame = requestAnimationFrame(function tick(now) {
      planeLayer.setPosition(orbitPosition(simulatedOrbit, now))
      frame = requestAnimationFrame(tick)
    })

    return () => {
      cancelAnimationFrame(frame)
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
            {mapRef.current && <SearchBox 
                accessToken={accessToken}
                map={mapRef.current}
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
