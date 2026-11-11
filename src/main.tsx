import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initStore } from './store';
import './styles.css';

// The last open project loads from the library before anything is shown.
initStore().finally(() => createRoot(document.getElementById('root')!).render(<App />));
