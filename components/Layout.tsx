import React, { useState, useRef, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { User } from '../types';
import { NotificationBell } from './NotificationBell';

interface LayoutProps {
  children: React.ReactNode;
  user: User | null;
  onLogout: () => void;
  meliData?: any;
  stats?: any;
}

const Sidebar = ({ activePath }: { activePath: string }) => {
  const getLinkClass = (path: string) => {
    const isActive = activePath === path;
    return `flex items-center gap-3 px-4 py-3 rounded-lg transition-colors font-medium ${isActive
      ? 'bg-primary/10 text-primary font-bold'
      : 'text-text-secondary-light dark:text-text-secondary-dark hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-text-main-light dark:hover:text-text-main-dark'
      }`;
  };

  const getIconClass = (path: string) => {
    return `material-symbols-outlined ${activePath === path ? 'filled' : ''}`;
  }

  return (
    <aside className="hidden md:flex w-64 flex-col bg-surface-light dark:bg-surface-dark border-r border-slate-200 dark:border-slate-800 h-full">
      <div className="p-6 flex items-center gap-3">
        <Link to="/" className="flex items-center gap-2 group hover:opacity-80 transition-opacity active:scale-95 transform duration-100">
          <div className="w-10 h-10 bg-meli-yellow rounded flex items-center justify-center relative flex-shrink-0 group-hover:rotate-12 transition-transform">
            <span className="material-symbols-outlined text-meli-purple font-bold text-3xl rotate-45 transform translate-y-1 -translate-x-1" style={{ fontWeight: 700 }}>arrow_downward</span>
          </div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight flex items-center">
              <span className="text-meli-text-yellow">Meli</span><span className="text-meli-purple dark:text-white">drop</span>
            </h1>
            <p className="text-[10px] text-text-secondary-light dark:text-text-secondary-dark font-medium leading-none">Dropshipping Tools</p>
          </div>
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2">
        <Link to="/" className={getLinkClass('/')}>
          <span className={getIconClass('/')}>dashboard</span>
          <span>Dashboard</span>
        </Link>
        <Link to="/importar" className={getLinkClass('/importar')}>
          <span className={getIconClass('/importar')}>download</span>
          <span>Importar</span>
        </Link>
        <Link to="/productos-prueba" className={getLinkClass('/productos-prueba')}>
          <span className={getIconClass('/productos-prueba')}>biotech</span>
          <span>Productos de Prueba</span>
        </Link>
        <Link to="/publicaciones" className={getLinkClass('/publicaciones')}>
          <span className={getIconClass('/publicaciones')}>inventory_2</span>
          <span>Publicaciones</span>
        </Link>
        <Link to="/ordenes" className={getLinkClass('/ordenes')}>
          <span className={getIconClass('/ordenes')}>shopping_cart</span>
          <span>Órdenes</span>
        </Link>
        <Link to="/mensajeria" className={getLinkClass('/mensajeria')}>
          <span className={getIconClass('/mensajeria')}>forum</span>
          <span>Mensajería</span>
        </Link>
        <Link to="/analitica" className={getLinkClass('/analitica')}>
          <span className={getIconClass('/analitica')}>analytics</span>
          <span>Analítica</span>
        </Link>
        <div className="flex-1"></div>
        <div className="my-2 border-t border-slate-200 dark:border-slate-700"></div>
        <Link to="/configuracion" className={getLinkClass('/configuracion')}>
          <span className={getIconClass('/configuracion')}>settings</span>
          <span>Configuración</span>
        </Link>
        <Link to="/perfil" className={getLinkClass('/perfil')}>
          <span className={getIconClass('/perfil')}>person</span>
          <span>Mi Perfil</span>
        </Link>
      </nav>
    </aside>
  );
};

const TopBar = ({ title, user, onLogout, meliData, stats }: { title: string, user: User | null, onLogout: () => void, meliData?: any, stats?: any }) => {
  const navigate = useNavigate();
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSync = () => {
    setIsSyncing(true);
    setTimeout(() => {
      setIsSyncing(false);
      // Simular notificación de éxito persistente por 3s
      const banner = document.createElement('div');
      banner.className = 'fixed top-4 right-4 bg-green-600 text-white px-6 py-3 rounded-xl shadow-2xl z-[100] animate-bounce flex items-center gap-2 font-bold';
      banner.innerHTML = '<span class="material-symbols-outlined">check_circle</span> Sincronización finalizada';
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 3000);
    }, 2000);
  };

  return (
    <header className="h-16 bg-surface-light dark:bg-surface-dark border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-6 z-10 sticky top-0">
      <div className="flex items-center gap-4">
        <button className="md:hidden p-2 text-text-secondary-light dark:text-text-secondary-dark hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">
          <span className="material-symbols-outlined">menu</span>
        </button>
        <h2 className="text-lg font-bold text-text-main-light dark:text-text-main-dark hidden sm:block">{title}</h2>
      </div>

      <div className="flex items-center gap-6">

        <button
          onClick={handleSync}
          disabled={isSyncing}
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-bold transition-all shadow-sm active:scale-95 disabled:opacity-70"
        >
          <span className={`material-symbols-outlined text-[20px] ${isSyncing ? 'animate-spin' : ''}`}>sync</span>
          <span className="hidden sm:inline">{isSyncing ? 'Syncing...' : 'Sincronizar ahora'}</span>
        </button>

        <div className="h-6 w-px bg-slate-200 dark:bg-slate-700 mx-1"></div>

        {/* New Notification Bell Component */}
        <NotificationBell meliData={meliData} stats={stats} />

        <div className="flex items-center gap-3 pl-2 cursor-pointer group relative">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-bold text-text-main-light dark:text-text-main-dark">{user?.name || "Usuario"}</p>
          </div>
          <img className="w-10 h-10 rounded-full object-cover border-2 border-slate-100 dark:border-slate-700" alt="Profile" src={user?.avatarUrl} />

          {/* Dropdown Menu - Perfil Agregado */}
          <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 hidden group-hover:block hover:block z-50 overflow-hidden">
            <button onClick={() => navigate('/perfil')} className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">person</span> Mi Perfil
            </button>
            <button onClick={onLogout} className="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2 border-t border-slate-100 dark:border-slate-700">
              <span className="material-symbols-outlined text-sm">logout</span> Cerrar Sesión
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};

export const Layout: React.FC<LayoutProps> = ({ children, user, onLogout, meliData, stats }) => {
  const location = useLocation();
  const getPageTitle = (path: string) => {
    if (path === '/') return 'Panel de Control';
    if (path === '/importar') return 'Importar Productos';
    if (path === '/productos-prueba') return 'Productos de Prueba';
    if (path === '/publicaciones') return 'Gestión de Publicaciones';
    if (path === '/ordenes') return 'Gestión de Órdenes';
    if (path === '/analitica') return 'Analítica de Rentabilidad';
    if (path === '/configuracion') return 'Configuración';
    if (path === '/perfil') return 'Mi Perfil';
    if (path === '/mensajeria') return 'Mensajería y Preguntas';
    return 'MeliDrop';
  }

  return (
    <div className="flex h-screen w-full bg-background-light dark:bg-background-dark">
      <Sidebar activePath={location.pathname} />
      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <TopBar title={getPageTitle(location.pathname)} user={user} onLogout={onLogout} meliData={meliData} stats={stats} />
        {children}
      </main>
    </div>
  );
};