import React, { useState } from 'react';
import { supabase } from '../services/supabase';
import { Link } from 'react-router-dom';

export const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      // App.tsx handles the session state change
    }
  };

  return (
    <div className="min-h-screen bg-background-light dark:bg-background-dark flex items-center justify-center p-4">
      <div className="bg-surface-light dark:bg-surface-dark p-8 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 w-full max-w-md">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 bg-meli-yellow rounded flex items-center justify-center">
            <span className="material-symbols-outlined text-meli-purple font-bold text-5xl rotate-45 transform translate-y-1 -translate-x-1" style={{ fontWeight: 700 }}>arrow_downward</span>
          </div>
        </div>
        <h2 className="text-2xl font-bold text-center text-text-main-light dark:text-text-main-dark mb-2">Bienvenido a Melidrop</h2>
        <p className="text-center text-text-secondary-light dark:text-text-secondary-dark mb-8">Inicia sesión para gestionar tu negocio</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-main-light dark:text-text-main-dark mb-1">Correo Electrónico</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-text-main-light dark:text-text-main-dark focus:ring-2 focus:ring-primary focus:border-transparent"
              placeholder="tu@email.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-main-light dark:text-text-main-dark mb-1">Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-text-main-light dark:text-text-main-dark focus:ring-2 focus:ring-primary focus:border-transparent"
              placeholder="******"
            />
          </div>

          {error && <p className="text-red-500 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary-dark text-white font-bold py-3 rounded-lg transition-colors shadow-md disabled:opacity-50"
          >
            {loading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
        <div className="mt-6 text-center text-sm">
          <span className="text-text-secondary-light dark:text-text-secondary-dark">¿No tienes cuenta? </span>
          <Link to="/register" className="text-primary hover:text-primary-dark font-medium">Regístrate</Link>
        </div>
        <p className="mt-4 text-center text-xs text-text-secondary-light">Versión Demo v1.0.0</p>
      </div>
    </div>
  );
};
