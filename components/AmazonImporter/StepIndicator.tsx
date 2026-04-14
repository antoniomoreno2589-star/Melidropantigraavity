import React from 'react';
import { Step } from './types';

const STEP_LABELS = ['Configuración', 'ASINs', 'Procesar con IA', 'Atributos', 'Publicar'];

export const StepIndicator = ({ current, total }: { current: Step; total: number }) => (
    <div className="flex items-center justify-between mb-8 px-2">
        {STEP_LABELS.map((label, i) => {
            const stepNum = (i + 1) as Step;
            const isCompleted = current > stepNum;
            const isActive = current === stepNum;
            return (
                <React.Fragment key={stepNum}>
                    <div className="flex flex-col items-center gap-1">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-black transition-all ${
                            isCompleted ? 'bg-green-500 text-white shadow-lg shadow-green-500/30' :
                            isActive   ? 'bg-primary text-white shadow-lg shadow-primary/30 scale-110' :
                                         'bg-slate-100 dark:bg-slate-800 text-slate-400'
                        }`}>
                            {isCompleted
                                ? <span className="material-symbols-outlined text-[18px]">check</span>
                                : stepNum}
                        </div>
                        <span className={`text-[9px] font-black uppercase tracking-wider text-center w-16 ${
                            isActive ? 'text-primary' : isCompleted ? 'text-green-500' : 'text-slate-400'
                        }`}>{label}</span>
                    </div>
                    {i < STEP_LABELS.length - 1 && (
                        <div className={`flex-1 h-0.5 mx-1 transition-all ${
                            isCompleted ? 'bg-green-400' : 'bg-slate-200 dark:bg-slate-700'
                        }`} />
                    )}
                </React.Fragment>
            );
        })}
    </div>
);
