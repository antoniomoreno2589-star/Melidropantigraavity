import React from 'react';

export const SecurityHistoryPage = () => {
    return (
        <div className="flex-1 overflow-y-auto p-6 md:p-10">
            <h1 className="text-3xl font-bold mb-6 text-slate-900 dark:text-white">Historial de Seguridad</h1>
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                <table className="w-full text-left text-sm text-slate-600 dark:text-slate-400">
                    <thead className="bg-slate-50 dark:bg-slate-900 text-xs uppercase font-bold text-slate-700 dark:text-slate-300">
                        <tr>
                            <th className="px-6 py-3">Evento</th>
                            <th className="px-6 py-3">Ubicación</th>
                            <th className="px-6 py-3">IP</th>
                            <th className="px-6 py-3">Fecha</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                        <tr>
                            <td className="px-6 py-4">Inicio de Sesión</td>
                            <td className="px-6 py-4">CDMX, México</td>
                            <td className="px-6 py-4">192.168.1.1</td>
                            <td className="px-6 py-4">Hoy, 10:23 AM</td>
                        </tr>
                        <tr>
                            <td className="px-6 py-4">Cambio de Contraseña</td>
                            <td className="px-6 py-4">Navegador Web</td>
                            <td className="px-6 py-4">192.168.1.1</td>
                            <td className="px-6 py-4">Ayer, 4:15 PM</td>
                        </tr>
                        <tr>
                            <td className="px-6 py-4">Inicio de Sesión</td>
                            <td className="px-6 py-4">Guadalajara, México</td>
                            <td className="px-6 py-4">189.20.10.5</td>
                            <td className="px-6 py-4">23 Oct, 2023</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
};