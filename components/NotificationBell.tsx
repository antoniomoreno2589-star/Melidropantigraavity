import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Notification {
    id: string;
    type: 'sale' | 'question' | 'message' | 'claim';
    title: string;
    message: string;
    timestamp: Date;
    read: boolean;
    link?: string;
}

interface NotificationBellProps {
    meliData?: any;
    stats?: any;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({ meliData, stats }) => {
    const navigate = useNavigate();
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [lastCheck, setLastCheck] = useState<Date>(new Date());

    useEffect(() => {
        // Generate notifications based on stats
        const newNotifications: Notification[] = [];

        // Check for unanswered questions
        if (stats?.questionsUnanswered > 0) {
            newNotifications.push({
                id: `questions-${Date.now()}`,
                type: 'question',
                title: 'Preguntas sin responder',
                message: `Tienes ${stats.questionsUnanswered} pregunta${stats.questionsUnanswered > 1 ? 's' : ''} pendiente${stats.questionsUnanswered > 1 ? 's' : ''}`,
                timestamp: new Date(),
                read: false,
                link: '/mensajeria?tab=questions'
            });
        }

        // Check for unread messages
        if (stats?.messagesUnread > 0) {
            newNotifications.push({
                id: `messages-${Date.now()}`,
                type: 'message',
                title: 'Mensajes sin leer',
                message: `Tienes ${stats.messagesUnread} mensaje${stats.messagesUnread > 1 ? 's' : ''} sin leer`,
                timestamp: new Date(),
                read: false,
                link: '/mensajeria?tab=messages'
            });
        }

        // Check for new sales today
        if (stats?.salesToday > 0) {
            newNotifications.push({
                id: `sales-${Date.now()}`,
                type: 'sale',
                title: '¡Nueva venta!',
                message: `${stats.salesToday} venta${stats.salesToday > 1 ? 's' : ''} hoy por $${stats.incomeToday?.toLocaleString() || 0}`,
                timestamp: new Date(),
                read: false,
                link: '/mensajeria?tab=messages'
            });
        }

        setNotifications(newNotifications);
    }, [stats, meliData]);

    const unreadCount = notifications.filter(n => !n.read).length;

    const handleNotificationClick = (notification: Notification) => {
        // Mark as read
        setNotifications(prev => prev.map(n =>
            n.id === notification.id ? { ...n, read: true } : n
        ));

        // Navigate if link exists
        if (notification.link) {
            navigate(notification.link);
            setIsOpen(false);
        }
    };

    const markAllAsRead = () => {
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    };

    const getNotificationIcon = (type: string) => {
        switch (type) {
            case 'sale':
                return 'shopping_bag';
            case 'question':
                return 'help_center';
            case 'message':
                return 'mail';
            case 'claim':
                return 'warning';
            default:
                return 'notifications';
        }
    };

    const getNotificationColor = (type: string) => {
        switch (type) {
            case 'sale':
                return 'text-green-600 bg-green-50 dark:bg-green-900/20';
            case 'question':
                return 'text-purple-600 bg-purple-50 dark:bg-purple-900/20';
            case 'message':
                return 'text-blue-600 bg-blue-50 dark:bg-blue-900/20';
            case 'claim':
                return 'text-red-600 bg-red-50 dark:bg-red-900/20';
            default:
                return 'text-slate-600 bg-slate-50 dark:bg-slate-900/20';
        }
    };

    return (
        <div className="relative">
            {/* Bell Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="relative p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
                <span className="material-symbols-outlined">notifications</span>
                {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {/* Dropdown Panel */}
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <div
                        className="fixed inset-0 z-40"
                        onClick={() => setIsOpen(false)}
                    />

                    {/* Notification Panel */}
                    <div className="absolute right-0 top-full mt-2 w-80 max-h-96 overflow-y-auto bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 z-50">
                        {/* Header */}
                        <div className="sticky top-0 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 p-4 flex justify-between items-center">
                            <h3 className="font-bold text-slate-900 dark:text-white">Notificaciones</h3>
                            {unreadCount > 0 && (
                                <button
                                    onClick={markAllAsRead}
                                    className="text-xs text-primary hover:underline font-bold"
                                >
                                    Marcar todas como leídas
                                </button>
                            )}
                        </div>

                        {/* Notifications List */}
                        <div className="divide-y divide-slate-100 dark:divide-slate-700">
                            {notifications.length === 0 ? (
                                <div className="p-8 text-center">
                                    <span className="material-symbols-outlined text-4xl text-slate-300 dark:text-slate-600 mb-2">notifications_off</span>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">No hay notificaciones</p>
                                </div>
                            ) : (
                                notifications.map(notification => (
                                    <div
                                        key={notification.id}
                                        onClick={() => handleNotificationClick(notification)}
                                        className={`p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors ${!notification.read ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
                                            }`}
                                    >
                                        <div className="flex gap-3">
                                            <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${getNotificationColor(notification.type)}`}>
                                                <span className="material-symbols-outlined text-[20px]">
                                                    {getNotificationIcon(notification.type)}
                                                </span>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-start justify-between gap-2">
                                                    <p className="font-bold text-sm text-slate-900 dark:text-white">
                                                        {notification.title}
                                                    </p>
                                                    {!notification.read && (
                                                        <span className="flex-shrink-0 w-2 h-2 rounded-full bg-primary"></span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                                                    {notification.message}
                                                </p>
                                                <p className="text-[10px] text-slate-400 mt-1">
                                                    {notification.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
