import React from 'react';
import { amazonService } from '../../services/amazonService';
import { useAmazonImporter } from './useAmazonImporter';
import { StepIndicator } from './StepIndicator';
import { Step1Config, Step2Asins, Step3AI } from './steps/StepsConfig';
import { Step4Attributes, Step5Publish } from './steps/StepsReview';

export const AmazonImporter: React.FC = () => {
    // ─── Guard: Amazon must be connected ────────────────────────────────
    if (!amazonService.isAuthenticated()) {
        return (
            <div className="flex-1 overflow-auto p-6 flex items-center justify-center">
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-8 text-center max-w-md">
                    <span className="material-symbols-outlined text-amber-500 text-5xl mb-4 block">storefront</span>
                    <h3 className="text-lg font-black text-amber-900 dark:text-amber-100 mb-2">Amazon no está conectado</h3>
                    <p className="text-sm text-amber-700 dark:text-amber-300 mb-4">
                        Ve a <strong>Configuración</strong> e ingresa tus credenciales de Amazon Seller API.
                    </p>
                    <a href="/configuracion" className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-bold transition-colors shadow-sm shadow-amber-500/30">
                        <span className="material-symbols-outlined text-[18px]">settings</span>Ir a Configuración
                    </a>
                </div>
            </div>
        );
    }

    const hook = useAmazonImporter();
    const { step } = hook;

    return (
        <div className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900">
            <div className="max-w-5xl mx-auto p-6">
                {/* Header */}
                <div className="mb-6">
                    <h1 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                        <span className="text-2xl">📦</span>
                        Importador Amazon → MercadoLibre
                    </h1>
                    <p className="text-sm text-slate-500 mt-1">Importa productos con optimización de IA en 5 pasos</p>
                </div>

                {/* Step Indicator */}
                <StepIndicator current={step} total={5} />

                {/* Steps */}
                {step === 1 && <Step1Config {...hook} />}
                {step === 2 && <Step2Asins {...hook} />}
                {step === 3 && <Step3AI {...hook} />}
                {step === 4 && <Step4Attributes {...hook} />}
                {step === 5 && <Step5Publish {...hook} />}
            </div>
        </div>
    );
};
