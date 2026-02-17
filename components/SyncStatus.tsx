import React, { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';

interface SyncStatusProps {
    lastSyncAt?: string;
    nextSyncTime?: string; // e.g. "07:00"
}

export const SyncStatus: React.FC<SyncStatusProps> = ({
    lastSyncAt,
    nextSyncTime = "07:00"
}) => {
    const [timeAgo, setTimeAgo] = useState<string>('...');

    useEffect(() => {
        if (!lastSyncAt) return;

        const updateTime = () => {
            const last = new Date(lastSyncAt);
            const now = new Date();
            const diffMs = now.getTime() - last.getTime();
            const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            if (diffHrs > 0) {
                setTimeAgo(`${diffHrs}h`);
            } else {
                setTimeAgo(`${diffMins}m`);
            }
        };

        updateTime();
        const interval = setInterval(updateTime, 60000);
        return () => clearInterval(interval);
    }, [lastSyncAt]);

    return (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-2 flex items-center gap-4 shadow-sm">
            <div className="flex items-center gap-3">
                <div className="relative">
                    <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                    <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full animate-ping opacity-75"></div>
                </div>
                <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter leading-none mb-1">Sync:</span>
                    <span className="text-sm font-bold text-slate-700 dark:text-white leading-none">{timeAgo}</span>
                </div>
            </div>

            <div className="w-[1px] h-8 bg-slate-200 dark:bg-slate-700"></div>

            <div className="flex flex-col">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter leading-none mb-1">Prox:</span>
                <span className="text-sm font-bold text-slate-400 dark:text-slate-500 leading-none">{nextSyncTime}</span>
            </div>
        </div>
    );
};
