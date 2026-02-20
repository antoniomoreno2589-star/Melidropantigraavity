import React, { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { meliService } from '../services/meliService';

interface Message {
    id: number;
    text: string;
    time: string;
    isUser: boolean;
}

interface ChatSession {
    id: number;
    user: string;
    product?: string;
    productImage?: string | null;
    productTitle?: string;
    order?: string;
    sku?: string;
    price?: number;
    total?: number;
    time: string;
    dateCreated?: Date;
    unread: boolean;
    messages: Message[];
    status?: string; // for questions: UNANSWERED, ANSWERED, etc.
    packId?: string | number; // for messages
    counterpartId?: string | number; // for messages: buyerId
}

export const CommunicationsPage = () => {
    const [searchParams] = useSearchParams();
    const initialTab = (searchParams.get('tab') as 'questions' | 'messages') || 'questions';

    const [activeTab, setActiveTab] = useState<'questions' | 'messages'>(initialTab);
    const [selectedChatId, setSelectedChatId] = useState<number>(initialTab === 'questions' ? 1 : 101);
    const [showContextModal, setShowContextModal] = useState(false);
    const [replyText, setReplyText] = useState('');
    const [filterPending, setFilterPending] = useState(false);
    const [filterUnread, setFilterUnread] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Update active tab if URL changes
    useEffect(() => {
        const tab = searchParams.get('tab');
        if (tab === 'questions' || tab === 'messages') {
            setActiveTab(tab);
            setSelectedChatId(tab === 'questions' ? 1 : 101);
        }
    }, [searchParams]);

    const [questions, setQuestions] = useState<ChatSession[]>([]);
    const [messages, setMessages] = useState<ChatSession[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [itemDetails, setItemDetails] = useState<any>(null);
    const [isFetchingItem, setIsFetchingItem] = useState(false);

    const getSKU = (item: any) => {
        if (!item) return '';
        const skuAttr = item.attributes?.find((a: any) => a.id === 'SELLER_SKU');
        return skuAttr?.value_name || item.seller_custom_field || 'N/A';
    };

    useEffect(() => {
        const fetchMeliComms = async () => {
            console.log("CommunicationsPage: Fetching Meli communications...");
            setIsLoading(true);
            try {
                // Fetch Questions, Messages and Claims to find that "pending message"
                // Sequential fetches to avoid proxy saturation
                const meliOrders = await meliService.getOrders(20).catch(() => []);
                await new Promise(r => setTimeout(r, 200));

                const meliQuestions = await meliService.getQuestions('UNANSWERED').catch(() => []);
                await new Promise(r => setTimeout(r, 200));

                const meliMessages = await meliService.getMessages(20).catch(() => []);
                await new Promise(r => setTimeout(r, 200));

                const meliClaims = await meliService.getClaims(10).catch(() => []);

                console.log("CommunicationsPage: Data received", {
                    questions: meliQuestions,
                    messages: meliMessages,
                    claims: meliClaims,
                    orders: meliOrders
                });

                const formattedQuestions: ChatSession[] = (meliQuestions || []).map((q: any) => ({
                    id: q.id,
                    user: q.from?.nickname || `ID: ${q.from?.id || 'Unknown'}`,
                    product: q.item_id,
                    productImage: q.item?.thumbnail || q.item?.secure_thumbnail || null,
                    productTitle: q.item?.title || 'Producto',
                    dateCreated: new Date(q.date_created),
                    time: new Date(q.date_created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    unread: q.status === 'UNANSWERED',
                    status: q.status,
                    messages: [
                        { id: q.id, text: q.text, time: new Date(q.date_created).toLocaleTimeString(), isUser: false },
                        ...(q.answer ? [{
                            id: q.id + 1,
                            text: q.answer.text,
                            time: new Date(q.answer.date_created).toLocaleTimeString(),
                            isUser: true
                        }] : [])
                    ]
                })).sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime()); // Sort by most recent first

                const formattedMessages: ChatSession[] = (meliMessages || []).map((m: any) => {
                    // Handle pack structure vs conversation structure vs individual message structure
                    const fromMsg = m.message || (m.messages && m.messages.length > 0 ? m.messages[m.messages.length - 1] : m) || {};
                    const fromUser = m.buyer || fromMsg.from || {};
                    const toUser = m.seller || fromMsg.to || {};
                    const isFromMe = (fromUser.id || fromUser.user_id)?.toString() === meliService.getCredentials()?.id.toString();

                    return {
                        id: m.id || fromMsg.id || Math.random(),
                        user: isFromMe ? (toUser.nickname || toUser.name || 'Comprador') : (fromUser.nickname || fromUser.name || 'Comprador'),
                        product: m.order_id ? `Orden: ${m.order_id}` : (m.item_id ? `Item: ${m.item_id}` : (m.resource_id ? `Recurso: ${m.resource_id}` : 'Post-venta')),
                        productImage: m.item?.thumbnail || m.item?.secure_thumbnail || null,
                        productTitle: m.item?.title || null,
                        dateCreated: new Date(fromMsg.date || m.date_created || Date.now()),
                        time: fromMsg.date ? new Date(fromMsg.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Reciente',
                        unread: (m.unread_count > 0) || (fromMsg.status === 'unread') || (!fromMsg.read && !isFromMe && fromMsg.id),
                        packId: m.pack_id || m.id, // Assuming generic search returns basic pack info
                        counterpartId: isFromMe ? (toUser.id || toUser.user_id) : (fromUser.id || fromUser.user_id),
                        messages: [
                            {
                                id: fromMsg.id || 1,
                                text: fromMsg.message_body?.text || fromMsg.text || 'Sin contenido',
                                time: fromMsg.date ? new Date(fromMsg.date).toLocaleTimeString() : '',
                                isUser: m.from?.id ? (m.from.id.toString() === meliService.getCredentials()?.id.toString()) : isFromMe
                            }
                        ]
                    };
                }).sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime()); // Sort by most recent first

                // Merge orders that don't have conversations yet
                const existingPackIds = new Set(formattedMessages.map(m => m.packId?.toString()));
                const orderChats: ChatSession[] = (meliOrders || []).map((o: any) => {
                    const firstItem = o.order_items?.[0]?.item || {};
                    const buyer = o.buyer || {};
                    const productTitle = firstItem.title || 'Producto sin título';
                    const productSku = firstItem.seller_sku || firstItem.seller_custom_field || 'N/A';
                    const productPrice = o.total_amount || 0;

                    // Try multiple sources for the image
                    let productImage = null;
                    if (firstItem.thumbnail) {
                        productImage = firstItem.thumbnail;
                    } else if (firstItem.secure_thumbnail) {
                        productImage = firstItem.secure_thumbnail;
                    } else if (firstItem.picture_url) {
                        productImage = firstItem.picture_url;
                    } else if (firstItem.pictures && firstItem.pictures.length > 0) {
                        productImage = firstItem.pictures[0].url || firstItem.pictures[0].secure_url;
                    }

                    console.log('Order item image:', {
                        orderId: o.id,
                        itemId: firstItem.id,
                        thumbnail: firstItem.thumbnail,
                        secure_thumbnail: firstItem.secure_thumbnail,
                        picture_url: firstItem.picture_url,
                        pictures: firstItem.pictures,
                        finalImage: productImage
                    });

                    return {
                        id: o.id,
                        user: o.buyer?.nickname || `Comprador: ${o.buyer?.id}`,
                        product: productTitle,
                        productImage: productImage,
                        productTitle: productTitle,
                        order: `#${o.id}`,
                        sku: productSku,
                        price: productPrice,
                        total: productPrice,
                        dateCreated: new Date(o.date_created),
                        time: new Date(o.date_created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        unread: false,
                        packId: o.pack_id || o.id,
                        counterpartId: o.buyer?.id,
                        messages: [
                            {
                                id: 999999,
                                text: 'Todavía no hay mensajes. Escribe al comprador para iniciar la conversación.',
                                time: new Date(o.date_created).toLocaleTimeString(),
                                isUser: false
                            }
                        ],
                        status: 'NO_MESSAGES'
                    };
                }).sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime()); // Sort by most recent first

                // Add claims to messages list
                const formattedClaims: ChatSession[] = (meliClaims || []).map((c: any) => ({
                    id: c.id,
                    user: `RECLAMO: ${c.id}`,
                    product: `Orden: ${c.resource_id}`,
                    time: new Date(c.date_created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    unread: c.status === 'opened' || c.status === 'reopened',
                    messages: [
                        { id: c.id, text: `Estado: ${c.status} - Tipo: ${c.type}. Revisa tu cuenta de Mercado Libre.`, time: new Date(c.date_created).toLocaleTimeString(), isUser: false }
                    ]
                }));

                console.log('Formatted data:', {
                    questionsCount: formattedQuestions.length,
                    messagesCount: formattedMessages.length,
                    claimsCount: formattedClaims.length,
                    ordersCount: orderChats.length
                });

                // Combine and sort all messages by dateCreated
                const combinedMessages = [...formattedMessages, ...formattedClaims, ...orderChats]
                    .sort((a, b) => {
                        const dateA = a.dateCreated || new Date(0);
                        const dateB = b.dateCreated || new Date(0);
                        return dateB.getTime() - dateA.getTime(); // Most recent first
                    });

                console.log('Combined messages sorted:', combinedMessages.length);

                setQuestions(formattedQuestions);
                setMessages(combinedMessages);

                // Set initial selection
                const currentList = activeTab === 'questions' ? formattedQuestions : combinedMessages;
                if (currentList.length > 0) {
                    setSelectedChatId(currentList[0].id);
                }
            } catch (err) {
                console.error("CommunicationsPage: Error fetching communications:", err);
                alert('Error al cargar mensajes: ' + (err as Error).message);
            } finally {
                setIsLoading(false);
            }
        };

        fetchMeliComms();
    }, [activeTab]);

    const getFilteredList = () => {
        let list = activeTab === 'questions' ? questions : messages;
        if (filterUnread) {
            list = list.filter(c => c.unread);
        }
        if (filterPending) {
            if (activeTab === 'questions') {
                list = list.filter(c => c.status === 'UNANSWERED');
            } else {
                // For messages, "Pending" might mean unread or specifically flagged.
                // Reaping user request: "pendientes de respuesta". 
                // For messages, usually "unread" implies pending. 
                // Any specific logic for "pending" messages beyond unread?
                // Let's assume Pending = Unread for messages for now, or maybe "Last message was NOT from me".
                list = list.filter(c => c.unread || (c.messages.length > 0 && !c.messages[c.messages.length - 1].isUser));
            }
        }
        return list;
    };

    const activeList = getFilteredList();
    const setActiveList = activeTab === 'questions' ? setQuestions : setMessages;

    const currentChat = activeList.find(c => c.id === selectedChatId) || activeList[0];

    // Scroll to bottom on new message
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [currentChat?.messages]);

    // Fetch item details when selection changes
    useEffect(() => {
        const fetchItem = async () => {
            if (!currentChat || !currentChat.product) {
                setItemDetails(null);
                return;
            }

            // Extract item ID (it might be a string like "MLM123" or an order ID)
            const itemId = currentChat.product.startsWith('MLM') ? currentChat.product : null;
            if (!itemId) {
                setItemDetails(null);
                return;
            }

            setIsFetchingItem(true);
            try {
                const data = await meliService.getItem(itemId);
                setItemDetails(data);
            } catch (e) {
                console.error("CommunicationsPage: Error fetching item context:", e);
                setItemDetails(null);
            } finally {
                setIsFetchingItem(false);
            }
        };

        fetchItem();
    }, [selectedChatId, currentChat?.product]);

    const addMessage = (text: string) => {
        const newMessage: Message = {
            id: Date.now(),
            text: text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isUser: true
        };

        const updatedList = activeList.map(chat => {
            if (chat.id === selectedChatId) {
                return {
                    ...chat,
                    unread: false, // Mark read on reply
                    messages: [...chat.messages, newMessage]
                };
            }
            return chat;
        });

        setActiveList(updatedList);
    };

    const handleSend = async () => {
        if (!replyText.trim()) return;

        // Optimistic update
        addMessage(replyText);
        const textToSend = replyText;
        setReplyText('');

        try {
            if (activeTab === 'questions') {
                await meliService.answerQuestion(currentChat.id, textToSend);
                // Mark locally as answered
                const updatedList = questions.map(q =>
                    q.id === currentChat.id ? { ...q, status: 'ANSWERED' } : q
                );
                setQuestions(updatedList);
                meliService.decrementUnansweredCount();
            } else {
                if (currentChat.packId && currentChat.counterpartId) {
                    await meliService.sendMessage(currentChat.packId, textToSend, currentChat.counterpartId);
                } else {
                    console.error("Missing packId or counterpartId for message");
                    // Fallback/Error handling if needed
                }
            }
        } catch (e: any) {
            console.error("CommunicationsPage: Send error", e);

            // Check for specific "not_unanswered_question" error
            const isAlreadyAnswered = e.message?.includes('not_unanswered_question') || e.message?.includes('Question') && e.message?.includes('is not unanswered');

            if (isAlreadyAnswered && activeTab === 'questions') {
                alert("Esta pregunta ya fue respondida anteriormente. Se marcará como completada.");
                // Mark locally as answered to sync UI
                const updatedList = questions.map(q =>
                    q.id === currentChat.id ? { ...q, status: 'ANSWERED' } : q
                );
                setQuestions(updatedList);
                meliService.decrementUnansweredCount();
            } else {
                alert(`Error al enviar el mensaje: ${e.message || 'Desconocido'}`);
                // TODO: Revert optimistic update here if needed (only if not answered)
            }
        }
    };


    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Trigger file input click
    const handleAttachClick = () => {
        fileInputRef.current?.click();
    };

    // Handle file selection
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const file = e.target.files[0];
            // Simulate uploading and sending an attachment message
            addMessage(`📎 Archivo adjunto: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

            // Reset input so the same file can be selected again if needed
            e.target.value = '';
        }
    };

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] overflow-hidden bg-background-light dark:bg-background-dark">
            <div className="flex-1 flex overflow-hidden">
                {/* Left Sidebar: Chat List */}
                <div className="w-full md:w-80 lg:w-96 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                    <div className="p-4 border-b border-slate-200 dark:border-slate-800">
                        <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">Mensajería</h1>
                        <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
                            <button
                                onClick={() => { setActiveTab('questions'); }}
                                className={`flex-1 py-1.5 text-sm font-bold rounded-md transition-all ${activeTab === 'questions' ? 'bg-white dark:bg-slate-700 text-primary shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                            >
                                Preguntas
                            </button>
                            <button
                                onClick={() => setActiveTab('messages')}
                                className={`flex-1 py-1.5 text-center text-sm font-medium rounded-md transition-colors ${activeTab === 'messages' ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                            >
                                Mensajes
                            </button>
                        </div>

                        {/* Filters */}
                        <div className="flex gap-2 mb-4 px-1">
                            <button
                                onClick={() => setFilterUnread(!filterUnread)}
                                className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${filterUnread ? 'bg-blue-100 border-blue-200 text-blue-700 dark:bg-blue-900/30 dark:border-blue-800 dark:text-blue-300' : 'bg-transparent border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}
                            >
                                No leídos
                            </button>
                            <button
                                onClick={() => setFilterPending(!filterPending)}
                                className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${filterPending ? 'bg-orange-100 border-orange-200 text-orange-700 dark:bg-orange-900/30 dark:border-orange-800 dark:text-orange-300' : 'bg-transparent border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}
                            >
                                Pendientes
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto">
                        {isLoading ? (
                            <div className="p-10 text-center">
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
                                <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">Sincronizando...</p>
                            </div>
                        ) : activeList.length === 0 ? (
                            <div className="p-10 text-center">
                                <p className="text-sm text-slate-400 font-bold">No hay {activeTab === 'questions' ? 'preguntas' : 'mensajes'} pendientes</p>
                            </div>
                        ) : (
                            activeList.map(item => (
                                <div
                                    key={item.id}
                                    onClick={() => setSelectedChatId(item.id)}
                                    className={`p-4 border-b border-slate-100 dark:border-slate-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${selectedChatId === item.id ? 'bg-blue-50 dark:bg-blue-900/10 border-l-4 border-l-primary' : 'border-l-4 border-l-transparent'}`}
                                >
                                    <div className="flex gap-3">
                                        {/* Product Image Thumbnail */}
                                        {item.productImage ? (
                                            <img
                                                src={item.productImage}
                                                alt={item.productTitle || 'Producto'}
                                                className="w-12 h-12 rounded-lg object-cover flex-shrink-0 border border-slate-200 dark:border-slate-700"
                                            />
                                        ) : (
                                            <div className="w-12 h-12 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                                                <span className="material-symbols-outlined text-slate-400 text-[20px]">inventory_2</span>
                                            </div>
                                        )}

                                        {/* Content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-start mb-1">
                                                <span className={`text-sm font-bold ${item.unread ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400'}`}>
                                                    {item.user}
                                                </span>
                                                <span className="text-[10px] text-slate-400">{item.time}</span>
                                            </div>
                                            <p className="text-xs text-slate-500 mb-1 line-clamp-1 italic">
                                                {/* @ts-ignore */}
                                                {item.productTitle || item.product || `Orden: ${item.order}`}
                                            </p>

                                            {/* Badges con información de la venta */}
                                            {activeTab === 'messages' && (item.order || item.sku || item.price) && (
                                                <div className="flex flex-wrap gap-1.5 mb-2">
                                                    {item.order && (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-[10px] font-bold rounded-full">
                                                            <span className="material-symbols-outlined text-[12px]">receipt</span>
                                                            {item.order}
                                                        </span>
                                                    )}
                                                    {item.sku && item.sku !== 'N/A' && (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-[10px] font-bold rounded-full">
                                                            <span className="material-symbols-outlined text-[12px]">tag</span>
                                                            {item.sku}
                                                        </span>
                                                    )}
                                                    {item.price && item.price > 0 && (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-[10px] font-bold rounded-full">
                                                            <span className="material-symbols-outlined text-[12px]">payments</span>
                                                            ${item.price.toLocaleString()}
                                                        </span>
                                                    )}
                                                </div>
                                            )}

                                            <p className={`text-sm line-clamp-2 ${item.unread ? 'font-medium text-slate-800 dark:text-slate-200' : 'text-slate-500'}`}>
                                                {item.messages[item.messages.length - 1]?.text}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Right Area: Chat Interface */}
                <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0d141b]">
                    {/* Chat Header */}
                    <div className="h-16 px-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-900">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-slate-500 font-bold">
                                {currentChat?.user.charAt(0)}
                            </div>
                            <div>
                                <h3 className="font-bold text-slate-900 dark:text-white">{currentChat?.user}</h3>
                                <div className="flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                                    <p className="text-xs text-slate-500">En línea</p>
                                </div>
                            </div>
                        </div>
                        <button className="text-slate-400 hover:text-slate-600"><span className="material-symbols-outlined">more_vert</span></button>
                    </div>

                    {/* Messages Area */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-6">
                        {!currentChat ? (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400">
                                <span className="material-symbols-outlined text-6xl mb-4">forum</span>
                                <p className="font-bold">Selecciona una conversación</p>
                                <p className="text-sm">Tus mensajes y preguntas aparecerán aquí</p>
                            </div>
                        ) : (
                            <>
                                {/* Context Bubble (Product Info) */}
                                <div className="flex justify-center sticky top-0 z-10 transition-all">
                                    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 flex gap-3 max-w-md shadow-sm opacity-95 backdrop-blur-sm">
                                        <div
                                            className="w-12 h-12 bg-slate-100 rounded bg-cover bg-center border border-slate-100 dark:border-slate-700"
                                            style={{ backgroundImage: `url(${itemDetails?.thumbnail || 'https://picsum.photos/50'})` }}
                                        ></div>
                                        <div>
                                            <p className="text-xs text-slate-500 uppercase font-bold flex items-center gap-1">
                                                Sobre la publicación
                                                {isFetchingItem && <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>}
                                            </p>
                                            <p className="text-sm font-bold text-slate-900 dark:text-white line-clamp-1">
                                                {itemDetails?.title || currentChat.product || 'Sin contexto'}
                                            </p>
                                            <div className="flex items-center gap-2 mt-0.5">
                                                <span className="text-[9px] font-bold bg-slate-100 dark:bg-slate-700 text-slate-500 px-1 rounded uppercase tracking-tighter">SKU</span>
                                                <span className="text-[10px] font-mono text-slate-600 dark:text-slate-400">{getSKU(itemDetails)}</span>
                                            </div>
                                            <div className="flex gap-3 mt-1.5 pt-1 border-t border-slate-100 dark:border-slate-700">
                                                <button
                                                    onClick={() => setShowContextModal(true)}
                                                    className="text-[10px] text-slate-500 cursor-pointer hover:text-primary font-bold flex items-center gap-1"
                                                >
                                                    Ver detalles <span className="material-symbols-outlined text-[10px]">info</span>
                                                </button>
                                                {itemDetails?.permalink && (
                                                    <a
                                                        href={itemDetails.permalink}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-[10px] text-primary cursor-pointer hover:underline font-bold flex items-center gap-1"
                                                    >
                                                        Ir a ML <span className="material-symbols-outlined text-[10px]">open_in_new</span>
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Chat History */}
                                {currentChat.messages.map((msg) => (
                                    <div key={msg.id} className={`flex gap-3 ${msg.isUser ? 'justify-end' : ''}`}>
                                        {!msg.isUser && (
                                            <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex-shrink-0 flex items-center justify-center text-xs font-bold text-slate-500">
                                                {currentChat.user.charAt(0)}
                                            </div>
                                        )}
                                        <div className={`flex flex-col gap-1 max-w-[70%] ${msg.isUser ? 'items-end' : ''}`}>
                                            <div className={`p-3 shadow-sm ${msg.isUser
                                                ? 'bg-primary text-white rounded-2xl rounded-tr-none'
                                                : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl rounded-tl-none text-slate-800 dark:text-slate-200'
                                                }`}>
                                                <p className="text-sm leading-relaxed whitespace-pre-line">{msg.text}</p>
                                            </div>
                                            <span className="text-[10px] text-slate-400 mx-1 flex items-center gap-1">
                                                {msg.time}
                                                {msg.isUser && <span className="material-symbols-outlined text-[12px] text-primary">done_all</span>}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                                <div ref={chatEndRef}></div>
                            </>
                        )}
                    </div>

                    {/* Input Area */}
                    <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
                        {/* Hidden File Input */}
                        <input
                            type="file"
                            ref={fileInputRef}
                            className="hidden"
                            onChange={handleFileChange}
                        />

                        <div className="flex gap-2 items-end bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-2">
                            {/* Only show attachment button for Messages tab */}
                            {activeTab === 'messages' && (
                                <button
                                    onClick={handleAttachClick}
                                    title="Adjuntar archivo"
                                    className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                                >
                                    <span className="material-symbols-outlined">attach_file</span>
                                </button>
                            )}

                            <textarea
                                value={replyText}
                                onChange={(e) => setReplyText(e.target.value)}
                                onKeyDown={handleKeyPress}
                                placeholder={activeTab === 'questions' ? "Responde la pregunta..." : "Escribe un mensaje..."}
                                className="flex-1 bg-transparent border-none focus:ring-0 text-slate-900 dark:text-white text-sm max-h-32 resize-none py-2.5"
                                rows={1}
                            ></textarea>


                            <button
                                onClick={handleSend}
                                disabled={!replyText.trim()}
                                className={`p-2 rounded-lg transition-colors shadow-sm ${!replyText.trim() ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed' : 'bg-primary text-white hover:bg-primary-dark'}`}
                            >
                                <span className="material-symbols-outlined text-[20px]">send</span>
                            </button>
                        </div>
                        <p className="text-[10px] text-slate-400 text-center mt-2">
                            Enter para enviar. Shift + Enter para salto de línea.
                        </p>
                    </div>
                </div>
            </div>

            {/* Context Details Modal */}
            {showContextModal && currentChat && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden transform scale-100 transition-all">
                        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
                            <h3 className="font-bold text-lg text-slate-900 dark:text-white">
                                Detalle de {activeTab === 'questions' ? 'Publicación' : 'Orden'}
                            </h3>
                            <button onClick={() => setShowContextModal(false)}><span className="material-symbols-outlined text-slate-400 hover:text-slate-600">close</span></button>
                        </div>
                        <div className="p-6">
                            <div className="flex items-start gap-4 mb-4">
                                <div
                                    className="w-24 h-24 bg-slate-100 rounded-lg bg-cover bg-center border border-slate-200 dark:border-slate-600"
                                    style={{ backgroundImage: `url(${itemDetails?.pictures?.[0]?.url || itemDetails?.thumbnail || 'https://picsum.photos/200'})` }}
                                ></div>
                                <div>
                                    <p className="font-bold text-slate-900 dark:text-white line-clamp-2 text-sm">
                                        {itemDetails?.title || currentChat.product}
                                    </p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[10px] uppercase font-bold bg-slate-100 dark:bg-slate-700 text-slate-500 px-1.5 py-0.5 rounded">
                                            {activeTab === 'questions' ? 'ID' : 'ORDEN'}
                                        </span>
                                        <p className="text-xs text-slate-500 font-mono">
                                            {/* @ts-ignore */}
                                            {activeTab === 'questions' ? currentChat.product : currentChat.order}
                                        </p>
                                    </div>
                                    <div className="mt-2 inline-block px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-sm font-bold rounded border border-green-200 dark:border-green-800">
                                        ${(itemDetails?.price || currentChat.price || 0).toLocaleString()} {itemDetails?.currency_id || 'MXN'}
                                    </div>
                                </div>
                            </div>

                            <hr className="border-slate-100 dark:border-slate-700 my-4" />

                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div className="p-2 bg-slate-50 dark:bg-slate-900/50 rounded">
                                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Estado</p>
                                    <p className="font-medium text-slate-900 dark:text-white flex items-center gap-1">
                                        <span className={`w-2 h-2 rounded-full ${itemDetails?.status === 'active' ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
                                        {itemDetails?.status === 'active' ? 'Activo' : (itemDetails?.status || 'Buscando...')}
                                    </p>
                                </div>
                                <div className="p-2 bg-slate-50 dark:bg-slate-900/50 rounded">
                                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Stock</p>
                                    <p className="font-medium text-slate-900 dark:text-white">
                                        {itemDetails?.available_quantity !== undefined ? `${itemDetails.available_quantity} Unidades` : '...'}
                                    </p>
                                </div>
                                <div className="p-2 bg-slate-50 dark:bg-slate-900/50 rounded">
                                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Comprador</p>
                                    <p className="font-medium text-slate-900 dark:text-white truncate" title={currentChat.user}>{currentChat.user}</p>
                                </div>
                                <div className="p-2 bg-slate-50 dark:bg-slate-900/50 rounded">
                                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Historial</p>
                                    <p className="font-medium text-slate-900 dark:text-white">3 Compras</p>
                                </div>
                            </div>

                            <div className="mt-6 flex justify-end">
                                <button onClick={() => setShowContextModal(false)} className="px-4 py-2 bg-primary text-white font-bold rounded-lg hover:bg-primary-dark transition-colors text-sm shadow-sm">
                                    Cerrar Detalles
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};