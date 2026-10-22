import React, { useState, useEffect } from 'react';
import { supabase } from './services/supabase';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoginPage } from './components/LoginPage';
import { RegisterPage } from './components/RegisterPage';
import { DashboardPage } from './components/DashboardPage';
import { AmazonImporter } from './components/AmazonImporter';
import { CatalogTable } from './components/CatalogTable';
import { ProfilePage } from './components/ProfilePage';
import { OrdersPage } from './components/OrdersPage';
import { SettingsPage } from './components/SettingsPage';
import { NotificationsPage } from './components/NotificationsPage';
import { CommunicationsPage } from './components/CommunicationsPage';
import { SecurityHistoryPage } from './components/SecurityHistoryPage';
import { AnalyticsPage } from './components/AnalyticsPage';
import { TestProductsPage } from './components/TestProductsPage';
import { UpdaterPage } from './components/UpdaterPage';
import { User, DashboardStats } from './types';
import { meliService } from './services/meliService';
import { claimUserCache } from './services/userCache';

// Shown until (or unless) Mercado Libre's real numbers load. This used to be
// mockService's sample data (12 sales, $15,400...), which a brand-new account
// with no sales read as real.
const NO_STATS: DashboardStats = {
  questionsUnanswered: 0, messagesUnread: 0, salesToday: 0, incomeToday: 0, questionsToday: 0, avgTicket: 0,
};

// Every setting Configuración and Actualización save into
// user_connections.margin_rules, and the localStorage key the pages and the
// importer read it from. Only five of these used to be restored, so on a new
// browser, or an account given another's settings, the rest (stock, warranty,
// prep and delivery days, default margins...) silently fell back to defaults.
const SAVED_SETTINGS: Array<[field: string, key: string, isJson?: boolean]> = [
  ['usa', 'melidrop_usa_rules', true],
  ['mx', 'melidrop_mx_rules', true],
  ['filters', 'melidrop_global_filters'],
  ['usa_default_margin', 'melidrop_usa_default_margin'],
  ['mx_default_margin', 'melidrop_mx_default_margin'],
  ['prep_days', 'melidrop_prep_days'],
  ['postal_code', 'melidrop_postal_code'],
  ['warranty_months', 'melidrop_warranty_months'],
  ['amazon_delivery_usa', 'melidrop_delivery_days_usa'],
  ['amazon_delivery_mx', 'melidrop_delivery_days_mx'],
  ['description_suffix', 'melidrop_description_suffix'],
  ['handling_time_usa', 'melidrop_handling_time_usa'],
  ['handling_time_mx', 'melidrop_handling_time_mx'],
  ['default_stock', 'melidrop_default_stock'],
  ['auto_promos', 'melidrop_auto_promos'],
  ['allow_price_decrease', 'melidrop_allow_price_decrease'],
  ['sync_frequency_hours', 'melidrop_sync_frequency_hours'],
  ['update_mode', 'melidrop_update_mode'],
  ['sync_params', 'melidrop_sync_params', true],
  ['fixed_delivery_days', 'melidrop_fixed_delivery_days', true],
  ['fixed_delivery_days_usa', 'melidrop_fixed_delivery_days_usa', true],
];

const App = () => {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [meliMetrics, setMeliMetrics] = useState<any>(null);
  // The user whose browser cache has been checked and synced. Pages only
  // render once it matches the session, so none of them can read (and, by
  // renewing a token, save) another user's cached Mercado Libre keys.
  const [cacheReadyFor, setCacheReadyFor] = useState<string | null>(null);

  // Intercept OAuth popup callbacks (test user connect flow)
  useEffect(() => {
    if (!window.opener) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (code) {
      window.opener.postMessage({ type: 'ml_oauth_code', code, state }, window.location.origin);
      setTimeout(() => window.close(), 200);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        setUser({
          name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Usuario',
          email: session.user.email || '',
          level: 'Vendedor',
          avatarUrl: session.user.user_metadata?.avatar_url || 'https://ui-avatars.com/api/?name=User'
        });
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) {
        setUser({
          name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Usuario',
          email: session.user.email || '',
          level: 'Vendedor',
          avatarUrl: session.user.user_metadata?.avatar_url || 'https://ui-avatars.com/api/?name=User'
        });
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Sync credentials from Supabase THEN load ML metrics
  useEffect(() => {
    if (!session?.user) return;

    const init = async () => {
      // 1. Sync credentials and settings from Supabase FIRST
      try {
        const { data: rows, error: rowsError } = await supabase
          .from('user_connections')
          .select('*')
          .eq('user_id', session.user.id)
          .order('updated_at', { ascending: false })
          .limit(1);
        const data = rows?.[0] ?? null;

        // Drop another user's cached keys and settings before anything below
        // reads them (see services/userCache.ts). Only judged on a successful
        // read: a failed one would make every cache look foreign.
        if (!rowsError && claimUserCache(session.user.id, data?.meli_credentials?.id)) {
          console.warn('App: browser cache belonged to another account — cleared');
          meliService.resetCaches();
          setMeliMetrics(null);
        }

        if (data) {
          console.log('App: Sincronizando configuraciones desde la nube...');
          if (data.meli_credentials) {
            localStorage.setItem('melidrop_meli_credentials', JSON.stringify(data.meli_credentials));
            const c = data.meli_credentials;
            if (c.nickname) setUser(prev => prev ? ({ ...prev, name: c.nickname }) : null);
          }
          if (data.amazon_credentials) localStorage.setItem('melidrop_amazon_credentials', JSON.stringify(data.amazon_credentials));
          if (data.exchange_rate) localStorage.setItem('melidrop_exchange_rate', data.exchange_rate.toString());
          if (data.margin_rules) {
            for (const [field, key, isJson] of SAVED_SETTINGS) {
              const value = data.margin_rules[field];
              if (value != null && value !== '') localStorage.setItem(key, isJson ? JSON.stringify(value) : String(value));
            }
          }
        }
      } catch (err) {
        console.error('App: Error sincronizando configuraciones:', err);
      }
      setCacheReadyFor(session.user.id);

      // 2. NOW read localStorage (already populated) and fetch ML metrics
      const credsRaw = localStorage.getItem('melidrop_meli_credentials');
      console.log('App: melidrop_meli_credentials present?', !!credsRaw);
      if (credsRaw) {
        try {
          const creds = JSON.parse(credsRaw);
          if (creds.nickname) setUser(prev => prev ? ({ ...prev, name: creds.nickname }) : null);
          const metrics = await meliService.getDashboardMetrics();
          setMeliMetrics(metrics);
          if (metrics.user?.nickname) {
            setUser(prev => prev ? ({
              ...prev,
              name: metrics.user.nickname,
              level: metrics.user.power_seller_status || 'Vendedor'
            }) : null);
          }
        } catch (err) {
          console.error('App: Error cargando Meli:', err);
        }
      }

      // 3. Auto-refresh test user token on startup
      meliService.autoRefreshTestUserToken().catch(() => {});
    };

    init();

    // Re-run test user token refresh every 3 hours while app is open
    const testTokenInterval = setInterval(() => {
      meliService.autoRefreshTestUserToken().catch(() => {});
    }, 3 * 60 * 60 * 1000);

    return () => clearInterval(testTokenInterval);
  }, [session]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-100">Cargando...</div>;
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  if (cacheReadyFor !== session.user.id) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-100">Cargando...</div>;
  }

  return (
    <Layout user={user} onLogout={handleLogout} meliData={meliMetrics} stats={meliMetrics?.stats || NO_STATS}>
      <Routes>
        <Route path="/" element={<DashboardPage user={user} stats={meliMetrics?.stats || NO_STATS} meliData={meliMetrics} />} />
        <Route path="/importar" element={<AmazonImporter />} />
        <Route path="/productos-prueba" element={<TestProductsPage />} />
        <Route path="/publicaciones" element={<CatalogTable />} />
        <Route path="/ordenes" element={<OrdersPage />} />
        <Route path="/actualizacion" element={<UpdaterPage />} />
        <Route path="/analitica" element={<AnalyticsPage />} />
        <Route path="/configuracion" element={<SettingsPage />} />
        <Route path="/perfil" element={<ProfilePage />} />

        {/* New Routes */}
        <Route path="/notificaciones" element={<NotificationsPage />} />
        <Route path="/mensajeria" element={<CommunicationsPage />} />
        <Route path="/historial-seguridad" element={<SecurityHistoryPage />} />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
};

export default App;
