import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { App } from './App';
import { AuthProvider, BranchProvider } from './lib/auth';
import { ToastHost } from './ui/kit';
import { ApiError } from './lib/api';

const client = new QueryClient({
  defaultOptions: { mutations: { networkMode: 'always' }, queries: { networkMode: 'always', staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500 && !e.network) && n < 2 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ToastHost>
          <AuthProvider>
            <BranchProvider>
              <App />
            </BranchProvider>
          </AuthProvider>
        </ToastHost>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
