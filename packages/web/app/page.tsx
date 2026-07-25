import { PlayPanel } from "./PlayPanel";

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: 640 }}>
      <h1>RUSHOOD</h1>
      <p data-testid="tagline">Pick your odds.</p>
      <PlayPanel />
    </main>
  );
}
