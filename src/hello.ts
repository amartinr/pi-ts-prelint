const nombre: string = "Mundo";
const saludo: string = `¡Hola, ${nombre}!`;
console.log(saludo);

// Función principal
function main(): void {
  console.log("Iniciando programa...");
  console.log("Este es un programa de prueba");
  console.log("Con múltiples líneas de código");

  // Variables de ejemplo
  const version: number = 1;
  const autor: string = "test";
  const activo: boolean = true;

  // Bucle de ejemplo
  for (let i = 0; i < 3; i++) {
    console.log(`Iteración ${i}`);
  }

  // Condicional
  if (activo) {
    console.log("El programa está activo");
  }

  // Array de ejemplo
  const items: string[] = ["uno", "dos", "tres"];
  items.forEach((item) => console.log(item));

  // Clases
  class Saludo {
    constructor(private nombre: string) {}
    decir(): string {
      return `Hola, ${this.nombre}!`;
    }
  }

  const s = new Saludo(nombre);
  console.log(s.decir());
  console.log("Programa finalizado correctamente");
}

main();
