import { Canvas } from '@react-three/fiber'

// Placeholder scene for Task 1 (scaffold + fixtures). The real lecture-player
// UI — built on sphere-shell's WindowShell, fed by the Opencast data layer
// recorded into src/opencast/__fixtures__ — arrives in later tasks.
export function App() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas camera={{ position: [0, 0, 3] }}>
        <ambientLight intensity={1} />
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#3f6f9f" />
        </mesh>
      </Canvas>
    </div>
  )
}
