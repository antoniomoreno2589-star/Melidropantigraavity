import React from 'react';

export const NotificationsPage = () => {
    const notifications = [
        { id: 1, title: 'Venta Realizada', message: 'Has vendido "Audífonos Sony" por $1,500.', type: 'sale', time: 'Hace 5 min' },
        { id: 2, title: 'Stock Bajo', message: 'El producto SKU-102 está por agotarse.', type: 'alert', time: 'Hace 2 horas' },
        { id: 3, title: 'Pregunta Nueva', message: 'Juan preguntó: "¿Tienen disponibilidad?"', type: 'info', time: 'Hace 1 día' },
    ];

    return (
        <div className="flex-1 overflow-y-auto p-6 md:p-10">
            <h1 className="text-3xl font-bold mb-6 text-slate-900 dark:text-white">Notificaciones</h1>
            <div className="space-y-4 max-w-3xl">
                {notifications.map(n => (
                    <div key={n.id} className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex gap-4">
                        <div className={`p-3 rounded-full h-fit ${n.type === 'sale' ? 'bg-green-100 text-green-600' : n.type === 'alert' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'}`}>
                            <span className="material-symbols-outlined">{n.type === 'sale' ? 'attach_money' : n.type === 'alert' ? 'warning' : 'info'}</span>
                        </div>
                        <div>
                            <h3 className="font-bold text-slate-900 dark:text-white">{n.title}</h3>
                            <p className="text-slate-500 dark:text-slate-300">{n.message}</p>
                            <span className="text-xs text-slate-400 mt-2 block">{n.time}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};