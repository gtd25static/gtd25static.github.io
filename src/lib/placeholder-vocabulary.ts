// Word lists for the placeholder workspace (lib/placeholder-content.ts): ordinary
// to-do-app content, in the browser's language (English or Spanish). It has to
// read like someone's real lists — filler text gave the swap away on sight — and
// every list is long enough that, combined, nothing repeats within a list.

export interface PlaceholderVocabulary {
  tasks: string[];          // a task or follow-up title
  when: string[];           // an optional tail for a title ('' = none)
  steps: string[];          // a subtask
  notes: string[];          // a sentence of a description or a discussion note
  lists: string[];          // a list name (never the Inbox's)
  folders: string[];        // a mindmap folder
  maps: string[];           // a mindmap
  nodes: string[];          // a mindmap node
  files: string[];          // a shared file's name stem
  searches: string[];       // a saved search
  people: string[];
  topics: string[];         // for link titles and URLs
}

const en: PlaceholderVocabulary = {
  tasks: [
    'Call the dentist', 'Renew car insurance', 'Book the annual check-up', 'Pay the electricity bill',
    'Cancel the old phone plan', 'Order printer ink', 'Return library books', 'Fix the kitchen tap',
    'Back up the laptop', 'Update the budget spreadsheet', 'Prepare slides for Monday', 'Reply to the landlord',
    'Buy a birthday present for Ana', 'Book train tickets', 'Confirm the hotel booking', 'Sort out tax documents',
    'Clear out the spare room', 'Organise photo albums', 'Pick up dry cleaning', 'Schedule a haircut',
    'Draft the quarterly report', 'Review project notes', 'Send the client invoice', 'Plan the weekly menu',
    'Replace the bike tyre', 'Clean the windows', 'Water the plants', 'Check the smoke alarm',
    'Read the onboarding guide', 'Finish the cover letter', 'Sign the lease renewal', 'File bank statements',
    'Research running shoes', 'Compare energy providers', 'Install the new router', 'Change the password manager',
    'Take the dog to the vet', 'Do the laundry', 'Put up the shelves', 'Measure the living room',
    'Write the blog post', 'Practise the conference talk', 'Update the CV', 'Archive old emails',
    'Ask Marta about the contract', 'Follow up with the plumber', 'Discuss holidays with the team', 'Agree on the move date',
    'Order new glasses', 'Book a table for Saturday', 'Get the car serviced', 'Print boarding passes',
    'Pack for the trip', 'Buy groceries', 'Defrost the freezer', 'Unsubscribe from newsletters',
    'Call mum', 'Plan the garden', 'Repot the basil', 'Fix the squeaky door',
    'Set up automatic backups', 'Check the warranty', 'Renew the passport', 'Fill in the expense report',
    'Prepare the team retro', 'Write meeting minutes', 'Review the pull request', 'Update the roadmap',
    'Sort the recycling', 'Buy light bulbs', 'Return the parcel', 'Collect the parcel from the post office',
  ],
  when: ['', '', '', '', ' this week', ' before Friday', ' tomorrow', ' next month', ' this weekend', ' for March', ' again', ' online'],
  steps: [
    'Find the receipt', 'Call customer service', 'Write the first draft', 'Ask for a quote',
    'Check opening hours', 'Pick a date', 'Compare prices', 'Read the reviews', 'Fill in the form',
    'Print the confirmation', 'Send a reminder', 'Book a slot', 'Make a list', 'Get the documents together',
    'Measure first', 'Order the parts', 'Test it', 'Clean up afterwards', 'Share with the team', 'Proofread',
  ],
  notes: [
    'Need to check the price first.', 'Waiting for an answer.', 'Agreed to look at it again next week.',
    'Best done in the morning.', 'Keep the receipt.', 'They said it takes about two weeks.',
    'Ask if there is a discount.', 'Bring the reference number.', 'Not urgent, but should not slip.',
    'Last time it took an hour.', 'Check with the others before deciding.', 'Online is cheaper.',
    'Remember to cancel the trial.', 'Write down what was agreed.', 'Can be done from home.',
    'Needs the signed copy.', 'Follow the checklist.', 'Split it into smaller steps.',
  ],
  lists: [
    'Home', 'Work', 'Errands', 'Shopping', 'Projects', 'Reading list', 'Garden', 'Car', 'Health',
    'Finances', 'Travel', 'Side project', 'Learning', 'House repairs', 'Gifts', 'Admin', 'Someday',
    'Kids', 'Fitness', 'Cooking', 'Team', 'People', 'Waiting for', 'Weekly review',
  ],
  folders: ['Work', 'Personal', 'Ideas', 'Archive', 'Study', 'Planning', 'Home', 'Projects'],
  maps: [
    'Q4 planning', 'Kitchen remodel', 'Holiday ideas', 'Course outline', 'Team structure', 'Garden layout',
    'Reading notes', 'Budget overview', 'Product ideas', 'Weekly routine', 'Move checklist', 'Talk outline',
  ],
  nodes: [
    'Goals', 'Budget', 'Timeline', 'Open questions', 'Next steps', 'Ideas', 'Risks', 'People', 'Resources',
    'Research', 'Options', 'Decisions', 'Notes', 'Costs', 'Suppliers', 'Phase one', 'Phase two', 'Later',
    'Must have', 'Nice to have', 'Feedback', 'Examples', 'Questions for Ana', 'Draft', 'Review', 'Done',
  ],
  files: ['notes', 'shopping-list', 'meeting-notes', 'packing-list', 'ideas', 'draft', 'todo', 'summary', 'checklist', 'recipe'],
  searches: ['invoice', 'call', 'book', 'buy', 'review', 'team', 'garden', 'trip', 'car', 'tax', 'email', 'report'],
  people: ['ana', 'marta', 'luis', 'sam', 'alex', 'nora', 'pablo', 'eva'],
  topics: ['Time management', 'Sourdough bread', 'Composting', 'Interval training', 'Index funds', 'Houseplants', 'Remote work', 'Road trips'],
};

const es: PlaceholderVocabulary = {
  tasks: [
    'Llamar al dentista', 'Renovar el seguro del coche', 'Pedir cita para la revisión', 'Pagar la factura de la luz',
    'Dar de baja la tarifa del móvil', 'Comprar tinta para la impresora', 'Devolver los libros de la biblioteca', 'Arreglar el grifo de la cocina',
    'Hacer copia de seguridad del portátil', 'Actualizar la hoja del presupuesto', 'Preparar las diapositivas del lunes', 'Contestar al casero',
    'Comprar el regalo de cumpleaños de Ana', 'Sacar los billetes de tren', 'Confirmar la reserva del hotel', 'Ordenar los papeles de la renta',
    'Vaciar el cuarto de invitados', 'Ordenar los álbumes de fotos', 'Recoger la ropa del tinte', 'Pedir hora en la peluquería',
    'Redactar el informe trimestral', 'Revisar las notas del proyecto', 'Enviar la factura al cliente', 'Planificar el menú de la semana',
    'Cambiar la rueda de la bici', 'Limpiar las ventanas', 'Regar las plantas', 'Revisar el detector de humo',
    'Leer la guía de bienvenida', 'Terminar la carta de presentación', 'Firmar la renovación del alquiler', 'Archivar los extractos del banco',
    'Buscar zapatillas para correr', 'Comparar compañías de luz', 'Instalar el router nuevo', 'Cambiar el gestor de contraseñas',
    'Llevar al perro al veterinario', 'Poner la lavadora', 'Montar las estanterías', 'Medir el salón',
    'Escribir la entrada del blog', 'Ensayar la charla', 'Actualizar el currículum', 'Archivar correos antiguos',
    'Preguntar a Marta por el contrato', 'Llamar otra vez al fontanero', 'Hablar de las vacaciones con el equipo', 'Cerrar la fecha de la mudanza',
    'Encargar gafas nuevas', 'Reservar mesa para el sábado', 'Llevar el coche al taller', 'Imprimir las tarjetas de embarque',
    'Hacer la maleta', 'Hacer la compra', 'Descongelar el congelador', 'Darse de baja de boletines',
    'Llamar a mamá', 'Planificar el huerto', 'Trasplantar la albahaca', 'Arreglar la puerta que chirría',
    'Programar copias automáticas', 'Mirar la garantía', 'Renovar el pasaporte', 'Rellenar la nota de gastos',
    'Preparar la retro del equipo', 'Escribir el acta de la reunión', 'Revisar el pull request', 'Actualizar la hoja de ruta',
    'Separar el reciclaje', 'Comprar bombillas', 'Devolver el paquete', 'Recoger el paquete en Correos',
  ],
  when: ['', '', '', '', ' esta semana', ' antes del viernes', ' mañana', ' el mes que viene', ' este finde', ' para marzo', ' otra vez', ' por internet'],
  steps: [
    'Buscar el ticket', 'Llamar a atención al cliente', 'Escribir un primer borrador', 'Pedir presupuesto',
    'Mirar el horario', 'Elegir fecha', 'Comparar precios', 'Leer opiniones', 'Rellenar el formulario',
    'Imprimir la confirmación', 'Mandar un recordatorio', 'Reservar hora', 'Hacer una lista', 'Juntar los documentos',
    'Medir antes', 'Pedir las piezas', 'Probarlo', 'Recoger después', 'Compartirlo con el equipo', 'Repasar el texto',
  ],
  notes: [
    'Primero mirar el precio.', 'Esperando respuesta.', 'Quedamos en verlo la semana que viene.',
    'Mejor por la mañana.', 'Guardar el ticket.', 'Dijeron que tarda unas dos semanas.',
    'Preguntar si hay descuento.', 'Llevar el número de referencia.', 'No es urgente, pero que no se pase.',
    'La última vez llevó una hora.', 'Comentarlo con los demás antes de decidir.', 'Por internet sale más barato.',
    'Acordarse de cancelar la prueba.', 'Apuntar lo que se acordó.', 'Se puede hacer desde casa.',
    'Hace falta la copia firmada.', 'Seguir la lista.', 'Partirlo en pasos más pequeños.',
  ],
  lists: [
    'Casa', 'Trabajo', 'Recados', 'Compras', 'Proyectos', 'Para leer', 'Jardín', 'Coche', 'Salud',
    'Finanzas', 'Viajes', 'Proyecto personal', 'Aprender', 'Arreglos', 'Regalos', 'Papeleo', 'Algún día',
    'Niños', 'Deporte', 'Cocina', 'Equipo', 'Personas', 'En espera', 'Revisión semanal',
  ],
  folders: ['Trabajo', 'Personal', 'Ideas', 'Archivo', 'Estudios', 'Planificación', 'Casa', 'Proyectos'],
  maps: [
    'Plan del trimestre', 'Reforma de la cocina', 'Ideas para vacaciones', 'Temario del curso', 'Estructura del equipo', 'Diseño del jardín',
    'Notas de lectura', 'Resumen del presupuesto', 'Ideas de producto', 'Rutina semanal', 'Lista de la mudanza', 'Guion de la charla',
  ],
  nodes: [
    'Objetivos', 'Presupuesto', 'Calendario', 'Dudas', 'Próximos pasos', 'Ideas', 'Riesgos', 'Personas', 'Recursos',
    'Investigar', 'Opciones', 'Decisiones', 'Notas', 'Costes', 'Proveedores', 'Fase uno', 'Fase dos', 'Más adelante',
    'Imprescindible', 'Estaría bien', 'Comentarios', 'Ejemplos', 'Preguntas para Ana', 'Borrador', 'Revisar', 'Hecho',
  ],
  files: ['notas', 'lista-compra', 'notas-reunion', 'lista-maleta', 'ideas', 'borrador', 'pendientes', 'resumen', 'checklist', 'receta'],
  searches: ['factura', 'llamar', 'reservar', 'comprar', 'revisar', 'equipo', 'jardín', 'viaje', 'coche', 'renta', 'correo', 'informe'],
  people: ['ana', 'marta', 'luis', 'pablo', 'elena', 'javi', 'nuria', 'carlos'],
  topics: ['Gestión del tiempo', 'Pan de masa madre', 'Compostaje', 'Entrenamiento por intervalos', 'Fondos indexados', 'Plantas de interior', 'Teletrabajo', 'Viajes en coche'],
};

/** The vocabulary for the browser's language: Spanish for `es…`, else English. */
export function placeholderVocabulary(language = typeof navigator === 'undefined' ? 'en' : navigator.language): PlaceholderVocabulary {
  return /^es\b/i.test(language) ? es : en;
}
