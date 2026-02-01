#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const pdf = require('pdf-parse');

program
  .name('pdf-tool')
  .description('PDF manipulation toolkit for OpenClaw')
  .version('1.0.0');

program
  .command('extract-text')
  .description('Extract text from a PDF file')
  .argument('<file>', 'Path to the PDF file')
  .option('-o, --output <file>', 'Output file path (default: print to stdout)')
  .action(async (file, options) => {
    try {
      const dataBuffer = fs.readFileSync(file);
      const data = await pdf(dataBuffer);
      
      if (options.output) {
        fs.writeFileSync(options.output, data.text);
        console.log(`Text extracted to ${options.output}`);
      } else {
        console.log(data.text);
      }
    } catch (error) {
      console.error('Error extracting text:', error.message);
      process.exit(1);
    }
  });

program
  .command('extract-table')
  .description('Extract tables from a PDF file (Heuristic)')
  .argument('<file>', 'Path to the PDF file')
  .option('-o, --output <file>', 'Output file path (default: print to stdout)')
  .option('--format <type>', 'Output format (csv, json)', 'csv')
  .option('--min-cols <number>', 'Minimum columns to consider a table', '2')
  .action(async (file, options) => {
    try {
      const dataBuffer = fs.readFileSync(file);
      const data = await pdf(dataBuffer);
      
      const lines = data.text.split('\n');
      const tables = [];
      let currentTable = [];
      
      // Simple heuristic: Lines with multiple whitespace-separated words that align roughly? 
      // Actually, pdf-parse text often loses alignment. 
      // We'll look for lines with > 2 gaps of > 1 space.
      
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (currentTable.length > 0) {
                tables.push(currentTable);
                currentTable = [];
            }
            return;
        }

        // Split by 2 or more spaces to find columns
        const columns = trimmed.split(/\s{2,}/);
        
        if (columns.length >= parseInt(options.minCols)) {
          currentTable.push(columns);
        } else {
           if (currentTable.length > 0) {
                tables.push(currentTable);
                currentTable = [];
            }
        }
      });
      
      if (currentTable.length > 0) tables.push(currentTable);

      let outputData = '';

      if (options.format === 'json') {
          outputData = JSON.stringify(tables, null, 2);
      } else {
          // Convert to CSV
          tables.forEach((table, index) => {
            if (index > 0) outputData += '\n\n';
            outputData += `--- Table ${index + 1} ---\n`;
            table.forEach(row => {
              outputData += row.map(c => `"${c.replace(/"/g, '""')}"`).join(',') + '\n';
            });
          });
      }

      if (options.output) {
        fs.writeFileSync(options.output, outputData);
        console.log(`Tables extracted to ${options.output}`);
      } else {
        console.log(outputData);
      }

    } catch (error) {
      console.error('Error extracting table:', error.message);
      process.exit(1);
    }
  });

program
  .command('info')
  .description('Get PDF metadata')
  .argument('<file>', 'Path to the PDF file')
  .action(async (file) => {
    try {
      const dataBuffer = fs.readFileSync(file);
      const data = await pdf(dataBuffer);
      
      console.log('PDF Info:');
      console.log(`Pages: ${data.numpages}`);
      console.log(`Info: ${JSON.stringify(data.info, null, 2)}`);
      console.log(`Metadata: ${JSON.stringify(data.metadata, null, 2)}`);
      console.log(`Version: ${data.version}`);
      
    } catch (error) {
      console.error('Error reading info:', error.message);
      process.exit(1);
    }
  });

program.parse();
