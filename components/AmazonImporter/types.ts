// Re-export ProcessedProduct from aiImporterService so consumers only need one import
export type { ProcessedProduct, ProcessedImage } from '../../services/aiImporterService';

export type Marketplace = 'MLM' | 'MLS';
export type ListingType = 'gold_special' | 'gold_pro';
export type Step = 1 | 2 | 3 | 4 | 5;

export interface LoadedProduct {
    asin: string;
    title: string;
    description: string;
    brand: string;
    price: number;
    currency: string;
    imageUrl: string;
    images: string[];
    category: string;
    attributes: any;
    loading: boolean;
    error: string | null;
}
