import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(<App />);
