import './tailwind.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import DigitalTwinDashboard from './components/DashboardAMR';

const root = createRoot(document.getElementById('root'));
root.render(<DigitalTwinDashboard />);
